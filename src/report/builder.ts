import type { Finding } from "../findings/finding.js";
import { normalizeRevertDetail } from "../findings/revert-detail.js";
import { isTestFile } from "../fixing/dispatch.js";
import { assignRetryIds, type RetryIdGenerator } from "./retry-id.js";
import {
  ReportSchema,
  type AiUsage,
  type BehaviorChange,
  type FailureSummary,
  type FixPolicy,
  type Report,
  type RunScope,
  type ScannerStatus,
} from "./schema.js";

const ZERO_AI_USAGE: AiUsage = {
  estimatedCostUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  sessions: 0,
};

const DEFAULT_FIX_POLICY: FixPolicy = {
  includeTests: false,
  include: [],
  exclude: [],
  includeGenerated: false,
  includeFixtures: false,
};

export type DerivedReportFields = {
  secrets: Finding[];
  reportOnly: Finding[];
  depBumps: Report["depBumps"];
  failureSummary: FailureSummary;
  unresolvedEligibleCount: number;
};

export function isUnresolvedEligibleFinding(
  finding: Finding,
  fixPolicy: FixPolicy = DEFAULT_FIX_POLICY,
): boolean {
  return (
    finding.category !== "secret" &&
    finding.track === "ai-fix" &&
    finding.status !== "fixed" &&
    finding.inScope !== false &&
    finding.inReportScope !== false &&
    finding.inFixScope !== false &&
    (fixPolicy.includeTests || !isTestFile(finding.file))
  );
}

export function deriveReportFields(
  findings: Finding[],
  scannerStatuses: ScannerStatus[],
  fixPolicy: FixPolicy = DEFAULT_FIX_POLICY,
): DerivedReportFields {
  const unresolvedEligible = findings.filter((f) =>
    isUnresolvedEligibleFinding(f, fixPolicy),
  );
  const blockingUnresolved = unresolvedEligible.filter((f) =>
    f.status === "reverted" || f.status === "unfixable",
  );
  const pendingUnresolved = unresolvedEligible.filter(
    (f) => f.status !== "reverted" && f.status !== "unfixable",
  );
  const failureSummary: FailureSummary = {
    blockingSecrets: findings.filter(
      (f) => f.category === "secret" && f.status !== "fixed",
    ).length,
    unresolvedEligible: pendingUnresolved.length,
    toolFailures: scannerStatuses.filter((s) => s.status === "failed").length,
    failedDeterministic: findings.filter(
      (f) => f.track === "deterministic" && f.status !== "fixed",
    ).length,
    sessionErrors: blockingUnresolved.filter(
      (f) => f.revertReason === "session-error",
    ).length,
    regressions: blockingUnresolved.filter((f) => f.revertReason === "regression")
      .length,
    typecheckFailures: blockingUnresolved.filter(
      (f) => f.revertReason === "typecheck",
    ).length,
    testFailures: blockingUnresolved.filter((f) => f.revertReason === "broke-test")
      .length,
  };

  return {
    secrets: findings.filter((f) => f.category === "secret"),
    reportOnly: findings.filter(
      (f) => f.track === "report-only" && f.category !== "secret",
    ),
    depBumps: findings
      .filter((f) => f.track === "deterministic" && f.remediation !== undefined)
      .map((f) => ({ findingId: f.id, remediation: f.remediation! })),
    failureSummary,
    unresolvedEligibleCount: pendingUnresolved.length,
  };
}

/** Accumulates per-finding outcomes and run metadata into a validated report.json. */
export class ReportBuilder {
  private readonly outcomes = new Map<string, Finding>();
  private readonly flagged: BehaviorChange[] = [];
  private scannerStatuses: ScannerStatus[] = [];

  constructor(private readonly generateRetryId?: RetryIdGenerator) {}

  /** Record (or update) a finding's final outcome by fingerprint. */
  recordOutcome(finding: Finding): void {
    const normalized = normalizeRevertDetail(finding.revertDetail);
    const outcome = { ...finding };
    if (normalized) outcome.revertDetail = normalized;
    else delete outcome.revertDetail;
    this.outcomes.set(finding.id, outcome);
  }

  recordOutcomes(findings: Finding[]): void {
    for (const f of findings) this.recordOutcome(f);
  }

  /** Flag a semantic test change for human review. */
  flagBehaviorChange(entry: BehaviorChange): void {
    this.flagged.push(entry);
  }

  /** Record per-scanner run outcomes (ran / skipped / failed) for the scanner-status line. */
  recordScannerStatuses(statuses: ScannerStatus[]): void {
    this.scannerStatuses = statuses;
  }

  build(meta: {
    loops: number;
    durationMs: number;
    exitStatus: number;
    aiUsage?: AiUsage;
    runScope?: RunScope;
    fixPolicy?: FixPolicy;
  }): Report {
    const findings = assignRetryIds([...this.outcomes.values()], this.generateRetryId);
    const fixPolicy = meta.fixPolicy ?? DEFAULT_FIX_POLICY;
    const derived = deriveReportFields(findings, this.scannerStatuses, fixPolicy);

    const report: Report = {
      findings,
      secrets: derived.secrets,
      reportOnly: derived.reportOnly,
      depBumps: derived.depBumps,
      flaggedBehaviorChanges: this.flagged,
      scannerStatuses: this.scannerStatuses,
      runScope: meta.runScope ?? { type: "scoped" },
      fixPolicy,
      aiUsage: meta.aiUsage ?? ZERO_AI_USAGE,
      failureSummary: derived.failureSummary,
      unresolvedEligibleCount: derived.unresolvedEligibleCount,
      loops: meta.loops,
      durationMs: meta.durationMs,
      exitStatus: meta.exitStatus,
    };

    return ReportSchema.parse(report);
  }
}
