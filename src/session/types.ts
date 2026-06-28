import type { Finding } from "../findings/finding.js";
import type { FileEdit } from "../fixing/change-set.js";

export type SessionRequest = {
  /** The file this session owns (plus its sibling test). */
  file: string;
  /** Findings to fix in this file. */
  findings: Finding[];
  /** The fully-rendered prompt for the AI. */
  prompt: string;
  /**
   * Live progress hook: called with a short label (e.g. "Edit src/a.ts") as activity
   * streams from the running session. Decoration only — outcomes are still judged
   * from the disk after the session ends.
   */
  onActivity?: (activity: string) => void;
  /** Aborted when tend's own session deadline expires. Session implementations should kill children. */
  signal?: AbortSignal;
};

export type FailureClass =
  | "tool-timeout"
  | "rate-limit"
  | "model-tool-failure"
  /**
   * The model/protocol refused this request in a way retrying can't fix: prompt too long,
   * output truncated at max tokens, or the requested model is unavailable (mid-run 404).
   * Terminal and no-burn — re-dispatching feeds the same oversized prompt or missing model.
   */
  | "model-rejected"
  | "sandbox-setup-failed"
  | "patch-conflict"
  | "unowned-patch"
  | "final-integration-failed"
  | "no-edit"
  | "no-op"
  | "regression"
  /**
   * The fix didn't introduce a new issue, it just failed to clear the finding it targeted.
   * Distinct from "regression" so it skips regression repair (there's no new finding to
   * repair) and gets a small bounded retry instead of the full regression-repair fan-out.
   */
  | "unresolved-target"
  | "typecheck"
  | "broke-test"
  | "suppression"
  | "needs-lockfile-update";

/**
 * Estimated AI cost/usage for a unit of work. `total_cost_usd` from Claude's
 * stream-json `result` message is a **client-side estimate**, never authoritative
 * billing — always surface it as "estimated AI cost".
 */
export type AiUsage = {
  /** Claude's `total_cost_usd` estimate (USD). A client-side estimate, not a bill. */
  estimatedCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** Number of Claude sessions (result messages) observed. */
  sessions: number;
};

/** Cost/token portion of usage parsed from a single stream (sessions tracked separately). */
export type TokenCost = Omit<AiUsage, "sessions">;

/** A usage record with everything zeroed. */
export const zeroUsage = (): AiUsage => ({
  estimatedCostUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  sessions: 0,
});

/** Sum two usage records field-by-field (used to roll usage up through the run). */
export function addUsage(a: AiUsage, b: AiUsage): AiUsage {
  return {
    estimatedCostUsd: a.estimatedCostUsd + b.estimatedCostUsd,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    sessions: a.sessions + b.sessions,
  };
}

export type SessionResult =
  | { ok: true; edits: FileEdit[]; usage?: AiUsage }
  | {
      ok: false;
      error: string;
      rateLimited: boolean;
      failureClass: Extract<
        FailureClass,
        "tool-timeout" | "rate-limit" | "model-tool-failure" | "model-rejected"
      >;
      usage?: AiUsage;
    };

/** One of the two interfaces in tend: drives an AI fix session. */
export interface SessionRunner {
  run(request: SessionRequest): Promise<SessionResult>;
}
