import type { FileEdit } from "../fixing/change-set.js";
import type { TokenCost } from "./types.js";

type ToolUse = { type: string; name?: string; input?: Record<string, unknown> };
type ResultUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};
type StreamEvent = {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  error?: string;
  /** `result` messages put the human-readable error/outcome text here in some CC versions. */
  result?: string;
  message?: { content?: ToolUse[]; stop_reason?: string };
  // `result` messages carry the run's estimated cost + token usage; field spellings
  // vary across Claude Code versions, so accept the ones we've seen.
  total_cost_usd?: number;
  cost_usd?: number;
  costUSD?: number;
  usage?: ResultUsage;
};

type ParsedStream = {
  edits: FileEdit[];
  rateLimited: boolean;
  errored: boolean;
  /**
   * The session failed in a way retrying can't fix — the prompt is too long, the output hit
   * the max-tokens ceiling, or the requested model is unavailable (mid-run 404). Distinct from
   * `rateLimited` (retryable) and a generic error (gets the full retry budget for nothing).
   */
  nonRetryable: boolean;
  /** Estimated cost/tokens from the stream's `result` message (zeroed if none). */
  usage: TokenCost;
};

const RATE_LIMIT_RE = /rate.?limit|overloaded|\b429\b/i;
/**
 * Errors no retry can clear. Kept deliberately specific so a transient/generic failure still
 * gets its normal retry budget — only these terminate immediately. Rate-limit is checked first
 * (it IS retryable) so an "overloaded" 429 never falls in here.
 */
const NON_RETRYABLE_RES = [
  /prompt is too long|input is too long|too many (?:input )?tokens/i,
  /max(?:imum)?[ _-]?(?:output[ _-]?)?tokens|output token limit/i,
  /context (?:window|length) exceeded/i,
  /\b404\b|not[_ ]found[_ ]error/i,
  /model[^.\n]{0,40}(?:not found|not available|does not exist)/i,
  /unknown model|invalid[ _-]?model/i,
];

function isNonRetryableText(text: string | undefined): boolean {
  if (!text) return false;
  return !RATE_LIMIT_RE.test(text) && NON_RETRYABLE_RES.some((re) => re.test(text));
}

/** A finite, non-negative number, or 0 for anything else (missing/NaN/negative). */
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

const zeroCost = (): TokenCost => ({
  estimatedCostUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
});

function parseEvent(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as StreamEvent;
  } catch {
    return null;
  }
}

function extractUsage(event: StreamEvent): TokenCost | null {
  const rawCost = event.total_cost_usd ?? event.cost_usd ?? event.costUSD;
  const u = event.usage;
  if (rawCost == null && u == null) return null;
  return {
    estimatedCostUsd: num(rawCost),
    inputTokens: num(u?.input_tokens),
    outputTokens: num(u?.output_tokens),
    cacheCreationInputTokens: num(u?.cache_creation_input_tokens),
    cacheReadInputTokens: num(u?.cache_read_input_tokens),
  };
}

function extractEdits(event: StreamEvent): FileEdit[] {
  const edits: FileEdit[] = [];
  for (const block of event.message?.content ?? []) {
    if (block.type === "tool_use" && block.name === "Write") {
      const path = block.input?.["file_path"];
      const contents = block.input?.["content"];
      if (typeof path === "string" && typeof contents === "string") {
        edits.push({ path, contents });
      }
    }
  }
  return edits;
}

type EventSignals = { rateLimited: boolean; errored: boolean; nonRetryable: boolean };

function eventSignals(event: StreamEvent): EventSignals {
  const errored = Boolean(event.is_error);
  const rateLimited = Boolean(event.is_error && event.error && RATE_LIMIT_RE.test(event.error));
  // Non-retryable signals can arrive on an is_error event, in a FAILED `result` message's text, or
  // as a max-tokens stop_reason on an assistant turn (the edit was truncated mid-write). The result
  // text is scanned ONLY when the result actually errored: on a success result `result` is the
  // model's free-text summary, which legitimately mentions HTTP 404, "max tokens", model names,
  // etc. while explaining the fix — scanning it there false-flags a good fix as a non-retryable
  // failure and reverts it.
  const nonRetryable =
    isNonRetryableText(event.error) ||
    (errored && isNonRetryableText(event.result)) ||
    event.message?.stop_reason === "max_tokens";
  return { rateLimited, errored, nonRetryable };
}

/**
 * Parse Claude Code `--output-format stream-json` (newline-delimited JSON) into the
 * file edits it produced. `Write` tool uses carry full file contents. Malformed lines
 * are skipped. Rate-limit / error signals are surfaced for backoff.
 */
export function parseStreamJson(raw: string): ParsedStream {
  const edits: FileEdit[] = [];
  let rateLimited = false;
  let errored = false;
  let nonRetryable = false;
  let usage: TokenCost | null = null;

  for (const line of raw.split("\n")) {
    const event = parseEvent(line);
    if (!event) continue;

    const sig = eventSignals(event);
    rateLimited ||= sig.rateLimited;
    errored ||= sig.errored;
    nonRetryable ||= sig.nonRetryable;

    if (event.type === "result") {
      const u = extractUsage(event);
      if (u) usage = u;
    }

    edits.push(...extractEdits(event));
  }

  // A non-retryable payload always counts as an error even if the stream forgot the is_error flag.
  if (nonRetryable) errored = true;
  // Rate-limit (retryable) wins if both somehow matched — never strand a 429 as terminal.
  if (rateLimited) nonRetryable = false;

  return { edits, rateLimited, errored, nonRetryable, usage: usage ?? zeroCost() };
}
