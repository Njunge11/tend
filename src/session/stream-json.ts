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
  is_error?: boolean;
  error?: string;
  message?: { content?: ToolUse[] };
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
  /** Estimated cost/tokens from the stream's `result` message (zeroed if none). */
  usage: TokenCost;
};

const RATE_LIMIT_RE = /rate.?limit|overloaded|\b429\b/i;

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

/**
 * Parse Claude Code `--output-format stream-json` (newline-delimited JSON) into the
 * file edits it produced. `Write` tool uses carry full file contents. Malformed lines
 * are skipped. Rate-limit / error signals are surfaced for backoff.
 */
export function parseStreamJson(raw: string): ParsedStream {
  const edits: FileEdit[] = [];
  let rateLimited = false;
  let errored = false;
  let usage: TokenCost | null = null;

  for (const line of raw.split("\n")) {
    const event = parseEvent(line);
    if (!event) continue;

    if (event.is_error) {
      errored = true;
      if (event.error && RATE_LIMIT_RE.test(event.error)) rateLimited = true;
    }

    if (event.type === "result") {
      const u = extractUsage(event);
      if (u) usage = u;
    }

    edits.push(...extractEdits(event));
  }

  return { edits, rateLimited, errored, usage: usage ?? zeroCost() };
}
