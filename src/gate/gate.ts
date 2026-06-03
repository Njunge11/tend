import type { CheckResult, RevertReason } from "./check.js";

export type Check = {
  name: string;
  run: () => Promise<CheckResult> | CheckResult;
};

export type GateOutcome =
  | { kept: true }
  | { kept: false; reason: RevertReason; detail: string; failedCheck: string };

/**
 * Run the verification checks in order, stopping at the first rejection and
 * surfacing its revert reason. A fix is kept only if every check passes.
 */
export async function runGate(checks: Check[]): Promise<GateOutcome> {
  for (const check of checks) {
    const result = await check.run();
    if (!result.ok) {
      return { kept: false, reason: result.reason, detail: result.detail, failedCheck: check.name };
    }
  }
  return { kept: true };
}
