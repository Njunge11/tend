import type { FailureSummary } from "./report/schema.js";

export function hasBlockingFailure(summary: FailureSummary): boolean {
  return (
    summary.blockingSecrets > 0 ||
    summary.unresolvedEligible > 0 ||
    summary.toolFailures > 0 ||
    summary.failedDeterministic > 0 ||
    summary.sessionErrors > 0 ||
    summary.regressions > 0 ||
    summary.typecheckFailures > 0 ||
    summary.testFailures > 0
  );
}
