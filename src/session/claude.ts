import { parseStreamJson } from "./stream-json.js";
import {
  zeroUsage,
  type AiUsage,
  type SessionRequest,
  type SessionResult,
  type SessionRunner,
} from "./types.js";

type ClaudeSpawn = (
  request: SessionRequest,
) => Promise<{ stdout: string; exitCode: number }>;

/** Drives a real `claude -p` session and parses its stream-json into edits. */
export class ClaudeSession implements SessionRunner {
  constructor(private readonly deps: { spawn: ClaudeSpawn }) {}

  async run(request: SessionRequest): Promise<SessionResult> {
    let stdout: string;
    let exitCode: number;
    try {
      ({ stdout, exitCode } = await this.deps.spawn(request));
    } catch (err) {
      // No stdout → no Claude result was observed; report zero usage and sessions=0.
      const error = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error,
        rateLimited: false,
        failureClass: classifySessionFailure(error),
        usage: zeroUsage(),
      };
    }

    const parsed = parseStreamJson(stdout);
    // A session ran (stdout exists) → one session, with whatever cost/usage it reported.
    const usage: AiUsage = { ...parsed.usage, sessions: 1 };

    if (parsed.rateLimited) {
      return {
        ok: false,
        error: "Claude session rate-limited",
        rateLimited: true,
        failureClass: "rate-limit",
        usage,
      };
    }
    if (exitCode !== 0 || parsed.errored) {
      const error = `Claude session failed (exit ${exitCode})`;
      return {
        ok: false,
        error,
        rateLimited: false,
        failureClass: classifySessionFailure(error, exitCode),
        usage,
      };
    }

    return { ok: true, edits: parsed.edits, usage };
  }
}

const TIMEOUT_OR_KILLED_RE = /\b(timed?\s*out|timeout|killed|terminated|sigterm|sigkill|exit\s+143)\b/i;

function classifySessionFailure(error: string, exitCode?: number): "tool-timeout" | "rate-limit" | "model-tool-failure" {
  if (/rate.?limit|overloaded|\b429\b/i.test(error)) return "rate-limit";
  if (exitCode === 143 || exitCode === 124 || TIMEOUT_OR_KILLED_RE.test(error)) return "tool-timeout";
  return "model-tool-failure";
}
