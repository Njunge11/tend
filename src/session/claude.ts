import { parseStreamJson } from "./stream-json.js";
import type { SessionRequest, SessionResult, SessionRunner } from "./types.js";

export type ClaudeSpawn = (
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
      return { ok: false, error: err instanceof Error ? err.message : String(err), rateLimited: false };
    }

    const parsed = parseStreamJson(stdout);

    if (parsed.rateLimited) {
      return { ok: false, error: "Claude session rate-limited", rateLimited: true };
    }
    if (exitCode !== 0 || parsed.errored) {
      return { ok: false, error: `Claude session failed (exit ${exitCode})`, rateLimited: false };
    }

    return { ok: true, edits: parsed.edits };
  }
}
