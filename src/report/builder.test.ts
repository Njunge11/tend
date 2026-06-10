import { describe, expect, it } from "vitest";
import { makeFinding } from "../../test/helpers/make-finding.js";
import { ReportBuilder } from "./builder.js";
import { ReportSchema } from "./schema.js";

describe("ReportBuilder", () => {
  it("T-094: builder accumulates per-finding outcomes over the run", () => {
    const builder = new ReportBuilder();
    const f = makeFinding({ file: "src/a.ts" });

    builder.recordOutcome({ ...f, status: "pending" });
    builder.recordOutcome({ ...f, status: "fixed" }); // later loop updates same finding

    const report = builder.build({ loops: 2, durationMs: 1000, exitStatus: 0 });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.status).toBe("fixed");
  });

  it("T-095: built report.json validates against the zod schema", () => {
    const builder = new ReportBuilder();
    builder.recordOutcome(makeFinding({ file: "src/a.ts" }));
    const report = builder.build({ loops: 1, durationMs: 42, exitStatus: 0 });

    expect(() => ReportSchema.parse(report)).not.toThrow();
  });

  it("preserves revert diagnostics in report findings", () => {
    const builder = new ReportBuilder();
    builder.recordOutcome({
      ...makeFinding({ file: "src/a.ts" }),
      status: "unfixable",
      attempts: 1,
      revertReason: "session-error",
      revertDetail: "Claude exited non-zero: 1",
    });

    const report = builder.build({ loops: 1, durationMs: 42, exitStatus: 0 });

    expect(report.findings[0]?.revertReason).toBe("session-error");
    expect(report.findings[0]?.revertDetail).toBe("Claude exited non-zero: 1");
    expect(() => ReportSchema.parse(report)).not.toThrow();
  });

  it("T-096: report includes secrets, dep bumps, flagged behavior changes, timings, exit status", () => {
    const builder = new ReportBuilder();
    const secret = makeFinding({ tool: "gitleaks", rule: "aws-key", category: "secret", file: "config/prod.ts" });
    const dep = makeFinding({ tool: "osv", rule: "CVE-1", category: "vuln-dep", file: "package.json" });
    builder.recordOutcome(secret);
    builder.recordOutcome({ ...dep, remediation: "Bump lodash from 4.17.15 to 4.17.19" });
    builder.flagBehaviorChange({ findingId: "x", file: "src/api.ts", note: "assertion changed" });

    const report = builder.build({ loops: 3, durationMs: 1234, exitStatus: 1 });

    expect(report.secrets).toHaveLength(1);
    expect(report.depBumps[0]?.remediation).toContain("4.17.19");
    expect(report.flaggedBehaviorChanges).toHaveLength(1);
    expect(report.durationMs).toBe(1234);
    expect(report.exitStatus).toBe(1);
  });

  it("separates report-only findings from secrets and deterministic dep bumps", () => {
    const builder = new ReportBuilder();
    const reportOnly = {
      ...makeFinding({
        tool: "jscpd",
        rule: "duplicate-code",
        category: "duplication",
        file: "src/a.ts",
        flowPath: [
          { file: "src/a.ts", line: 1 },
          { file: "src/b.ts", line: 20 },
        ],
      }),
      track: "report-only" as const,
    };
    const secret = makeFinding({
      tool: "gitleaks",
      rule: "aws-key",
      category: "secret",
      file: "config/prod.ts",
    });
    builder.recordOutcome(reportOnly);
    builder.recordOutcome(secret);

    const report = builder.build({ loops: 1, durationMs: 42, exitStatus: 1 });

    expect(report.secrets).toHaveLength(1);
    expect(report.secrets[0]).toMatchObject({ id: secret.id, category: "secret" });
    expect(report.reportOnly).toHaveLength(1);
    expect(report.reportOnly[0]).toMatchObject({
      id: reportOnly.id,
      track: "report-only",
      category: "duplication",
    });
    expect(report.depBumps).toStrictEqual([]);
  });

  it("derives failure summary and unresolved eligible counts", () => {
    const builder = new ReportBuilder();
    builder.recordOutcome({
      ...makeFinding({ file: "src/a.ts" }),
      status: "unfixable",
      revertReason: "typecheck",
    });
    builder.recordScannerStatuses([{ tool: "knip", status: "failed", reason: "boom" }]);

    const report = builder.build({ loops: 1, durationMs: 42, exitStatus: 1 });

    expect(report.unresolvedEligibleCount).toBe(0);
    expect(report.failureSummary).toMatchObject({
      unresolvedEligible: 0,
      toolFailures: 1,
      typecheckFailures: 1,
    });
  });

  it("excludes unsupported-strategy findings from unresolved eligible (never dispatched)", () => {
    const builder = new ReportBuilder();
    // The dispatcher never attempts this plan; counting it as unresolved eligible would
    // block exit 0 on work tend will never do.
    builder.recordOutcome({
      ...makeFinding({
        tool: "jscpd",
        rule: "duplicate-code",
        category: "duplication",
        file: "src/git/repo.ts",
      }),
      status: "pending",
      inScope: true,
      repairStrategy: "unsupported",
      repairStrategyReason: "report-only",
    });
    // A genuinely dispatchable pending finding still counts.
    builder.recordOutcome({
      ...makeFinding({ file: "src/b.ts" }),
      status: "pending",
      inScope: true,
      repairStrategy: "single-file-ai-edit",
    });

    const report = builder.build({ loops: 1, durationMs: 42, exitStatus: 1 });

    expect(report.unresolvedEligibleCount).toBe(1);
    expect(report.failureSummary.unresolvedEligible).toBe(1);
  });

  it("includes the run's estimated AI usage when provided to build()", () => {
    const builder = new ReportBuilder();
    builder.recordOutcome(makeFinding({ file: "src/a.ts" }));

    const report = builder.build({
      loops: 1,
      durationMs: 42,
      exitStatus: 0,
      aiUsage: {
        estimatedCostUsd: 1.84,
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationInputTokens: 100,
        cacheReadInputTokens: 200,
        sessions: 4,
      },
    });

    expect(report.aiUsage).toStrictEqual({
      estimatedCostUsd: 1.84,
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationInputTokens: 100,
      cacheReadInputTokens: 200,
      sessions: 4,
    });
  });

  it("defaults aiUsage to zero when build() is given none", () => {
    const builder = new ReportBuilder();
    builder.recordOutcome(makeFinding({ file: "src/a.ts" }));
    const report = builder.build({ loops: 1, durationMs: 42, exitStatus: 0 });
    expect(report.aiUsage).toStrictEqual({
      estimatedCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      sessions: 0,
    });
  });

  it("defaults missing aiUsage to zero when parsing an old report.json", () => {
    // A report written before usage tracking has no aiUsage field.
    const oldReport = {
      findings: [],
      secrets: [],
      depBumps: [],
      flaggedBehaviorChanges: [],
      scannerStatuses: [],
      loops: 1,
      durationMs: 100,
      exitStatus: 0,
    };
    const parsed = ReportSchema.parse(oldReport);
    expect(parsed.aiUsage).toStrictEqual({
      estimatedCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      sessions: 0,
    });
    expect(parsed.runScope).toStrictEqual({ type: "scoped" });
    expect(parsed.fixPolicy).toStrictEqual({
      includeTests: false,
      include: [],
      exclude: [],
      includeGenerated: false,
      includeFixtures: false,
    });
    expect(parsed.reportOnly).toStrictEqual([]);
    expect(parsed.failureSummary).toStrictEqual({
      blockingSecrets: 0,
      unresolvedEligible: 0,
      toolFailures: 0,
      failedDeterministic: 0,
      sessionErrors: 0,
      regressions: 0,
      typecheckFailures: 0,
      testFailures: 0,
      sandboxSetupFailures: 0,
      patchConflicts: 0,
      unownedPatches: 0,
      finalIntegrationFailures: 0,
    });
    expect(parsed.unresolvedEligibleCount).toBe(0);
  });

  it("includes run scope and fix policy metadata when provided to build()", () => {
    const builder = new ReportBuilder();
    builder.recordOutcome(makeFinding({ file: "src/a.ts" }));

    const report = builder.build({
      loops: 1,
      durationMs: 42,
      exitStatus: 0,
      runScope: { type: "all" },
      fixPolicy: {
        includeTests: true,
        include: ["dist/index.d.ts"],
        exclude: ["coverage/**"],
        includeGenerated: true,
        includeFixtures: false,
      },
    });

    expect(report.runScope).toStrictEqual({ type: "all" });
    expect(report.fixPolicy).toStrictEqual({
      includeTests: true,
      include: ["dist/index.d.ts"],
      exclude: ["coverage/**"],
      includeGenerated: true,
      includeFixtures: false,
    });
  });

  it("assigns unique human retry ids to report findings", () => {
    const ids = ["kx7p2q", "kx7p2q", "m8n4sa"];
    const builder = new ReportBuilder(() => ids.shift() ?? "z9z9z9");
    builder.recordOutcome(makeFinding({ file: "src/a.ts" }));
    builder.recordOutcome(makeFinding({ file: "src/b.ts" }));

    const report = builder.build({ loops: 1, durationMs: 42, exitStatus: 0 });

    expect(report.findings.map((f) => f.retryId)).toStrictEqual(["kx7p2q", "m8n4sa"]);
    expect(new Set(report.findings.map((f) => f.retryId)).size).toBe(report.findings.length);
  });

  it("preserves an existing unique retry id when rebuilding a report", () => {
    const builder = new ReportBuilder(() => "m8n4sa");
    builder.recordOutcome({ ...makeFinding({ file: "src/a.ts" }), retryId: "kx7p2q" });

    const report = builder.build({ loops: 1, durationMs: 42, exitStatus: 0 });

    expect(report.findings[0]?.retryId).toBe("kx7p2q");
  });
});
