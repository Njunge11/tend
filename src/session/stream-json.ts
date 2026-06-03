import type { FileEdit } from "../fixing/change-set.js";

type ToolUse = { type: string; name?: string; input?: Record<string, unknown> };
type StreamEvent = {
  type?: string;
  is_error?: boolean;
  error?: string;
  message?: { content?: ToolUse[] };
};

export type ParsedStream = {
  edits: FileEdit[];
  rateLimited: boolean;
  errored: boolean;
};

const RATE_LIMIT_RE = /rate.?limit|overloaded|\b429\b/i;

/**
 * Parse Claude Code `--output-format stream-json` (newline-delimited JSON) into the
 * file edits it produced. `Write` tool uses carry full file contents. Malformed lines
 * are skipped. Rate-limit / error signals are surfaced for backoff.
 */
export function parseStreamJson(raw: string): ParsedStream {
  const edits: FileEdit[] = [];
  let rateLimited = false;
  let errored = false;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: StreamEvent;
    try {
      event = JSON.parse(trimmed) as StreamEvent;
    } catch {
      continue; // skip non-JSON noise
    }

    if (event.is_error) {
      errored = true;
      if (event.error && RATE_LIMIT_RE.test(event.error)) rateLimited = true;
    }

    for (const block of event.message?.content ?? []) {
      if (block.type === "tool_use" && block.name === "Write") {
        const path = block.input?.["file_path"];
        const contents = block.input?.["content"];
        if (typeof path === "string" && typeof contents === "string") {
          edits.push({ path, contents });
        }
      }
    }
  }

  return { edits, rateLimited, errored };
}
