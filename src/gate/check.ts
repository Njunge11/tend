import type { Finding } from "../findings/finding.js";

export type RevertReason = NonNullable<Finding["revertReason"]>;

export type CheckResult =
  | { ok: true }
  | { ok: false; reason: RevertReason; detail: string };

export const pass = (): CheckResult => ({ ok: true });
export const reject = (reason: RevertReason, detail: string): CheckResult => ({
  ok: false,
  reason,
  detail,
});
