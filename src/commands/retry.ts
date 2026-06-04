import type { Finding } from "../findings/finding.js";
import { normalizeRevertDetail } from "../findings/revert-detail.js";
import type { RevertReason } from "../gate/check.js";
import type { FixOutcome } from "../orchestrator.js";
import type { Report } from "../report/schema.js";
import { resolveFindingId } from "./resolve-finding.js";

export type RetryDeps = {
  report?: Report;
  findings?: Finding[];
  baseBudget: number;
  /** Re-run the fix for a finding with the given (larger) attempt budget. */
  runFix: (finding: Finding, budget: number) => Promise<FixOutcome>;
};

export type RetryResult =
  | { outcome: "fixed"; finding: Finding; budget: number }
  | { outcome: "reverted"; finding: Finding; budget: number; reason: RevertReason }
  | { error: string };

function findingsOf(deps: RetryDeps): Finding[] {
  return deps.report?.findings ?? deps.findings ?? [];
}

function syncDerivedReportFields(report: Report): void {
  report.secrets = report.findings.filter((f) => f.category === "secret");
  report.depBumps = report.findings
    .filter((f) => f.remediation !== undefined)
    .map((f) => ({ findingId: f.id, remediation: f.remediation! }));
  report.exitStatus = report.secrets.length > 0 ? 1 : 0;
}

export function resolveRetryTarget(id: string, findings: Finding[]): Finding | { error: string } {
  const resolved = resolveFindingId(id, findings);
  if ("error" in resolved) return resolved;
  if (resolved.status === "fixed") return { error: `Finding ${resolved.id} is already fixed` };
  if (resolved.track !== "ai-fix") return { error: `Finding ${resolved.id} is not AI-fixable` };
  return resolved;
}

/** `tend retry <id>` — re-attempt a stubborn finding with a larger attempt budget. */
export async function retryCommand(
  id: string,
  deps: RetryDeps,
): Promise<RetryResult> {
  const resolved = resolveRetryTarget(id, findingsOf(deps));
  if ("error" in resolved) return resolved;

  const finding = resolved;
  const largerBudget = Math.max(deps.baseBudget * 2, finding.attempts + 1);
  finding.status = "fixing";

  const outcome = await deps.runFix(finding, largerBudget);
  if (outcome.kept) {
    finding.status = "fixed";
    delete finding.revertReason;
    delete finding.revertDetail;
    if (deps.report) syncDerivedReportFields(deps.report);
    return { outcome: "fixed", finding, budget: largerBudget };
  }

  const reason = outcome.reason ?? "session-error";
  finding.attempts += 1;
  finding.revertReason = reason;
  const detail = normalizeRevertDetail(outcome.detail);
  if (detail) finding.revertDetail = detail;
  else delete finding.revertDetail;
  finding.status = finding.attempts >= largerBudget ? "unfixable" : "reverted";
  if (deps.report) syncDerivedReportFields(deps.report);
  return { outcome: "reverted", finding, budget: largerBudget, reason };
}
