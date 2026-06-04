import { parseStreamJson } from "./stream-json.js";
import { zeroUsage, type AiUsage, type SessionRequest, type SessionResult, type SessionRunner } from "./types.js";

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
      return { ok: false, error: err instanceof Error ? err.message : String(err), rateLimited: false, usage: zeroUsage() };
    }

    const parsed = parseStreamJson(stdout);
    // A session ran (stdout exists) → one session, with whatever cost/usage it reported.
    const usage: AiUsage = { ...parsed.usage, sessions: 1 };

    if (parsed.rateLimited) {
      return { ok: false, error: "Claude session rate-limited", rateLimited: true, usage };
    }
    if (exitCode !== 0 || parsed.errored) {
      return { ok: false, error: `Claude session failed (exit ${exitCode})`, rateLimited: false, usage };
    }

    return { ok: true, edits: parsed.edits, usage };
  }
}
