import type { Finding } from "../findings/finding.js";
import { assignRetryIds, type RetryIdGenerator } from "./retry-id.js";
import { ReportSchema, type AiUsage, type BehaviorChange, type Report, type ScannerStatus } from "./schema.js";

const ZERO_AI_USAGE: AiUsage = {
  estimatedCostUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  sessions: 0,
};

/** Accumulates per-finding outcomes and run metadata into a validated report.json. */
export class ReportBuilder {
  private readonly outcomes = new Map<string, Finding>();
  private readonly flagged: BehaviorChange[] = [];
  private scannerStatuses: ScannerStatus[] = [];

  constructor(private readonly generateRetryId?: RetryIdGenerator) {}

  /** Record (or update) a finding's final outcome by fingerprint. */
  recordOutcome(finding: Finding): void {
    this.outcomes.set(finding.id, finding);
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

  build(meta: { loops: number; durationMs: number; exitStatus: number; aiUsage?: AiUsage }): Report {
    const findings = assignRetryIds([...this.outcomes.values()], this.generateRetryId);

    const report: Report = {
      findings,
      secrets: findings.filter((f) => f.category === "secret"),
      depBumps: findings
        .filter((f) => f.remediation !== undefined)
        .map((f) => ({ findingId: f.id, remediation: f.remediation! })),
      flaggedBehaviorChanges: this.flagged,
      scannerStatuses: this.scannerStatuses,
      aiUsage: meta.aiUsage ?? ZERO_AI_USAGE,
      loops: meta.loops,
      durationMs: meta.durationMs,
      exitStatus: meta.exitStatus,
    };

    return ReportSchema.parse(report);
  }
}
