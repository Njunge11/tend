import type { Finding } from "../findings/finding.js";
import type { FileEdit } from "../fixing/change-set.js";

export type SessionRequest = {
  /** The file this session owns (plus its sibling test). */
  file: string;
  /** Findings to fix in this file. */
  findings: Finding[];
  /** The fully-rendered prompt for the AI. */
  prompt: string;
};

export type SessionResult =
  | { ok: true; edits: FileEdit[] }
  | { ok: false; error: string; rateLimited: boolean };

/** One of the two interfaces in tend: drives an AI fix session. */
export interface SessionRunner {
  run(request: SessionRequest): Promise<SessionResult>;
}
