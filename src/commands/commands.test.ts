import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFinding } from "../../test/helpers/make-finding.js";
import { tmpRepo, type TmpRepo } from "../../test/helpers/tmp-repo.js";
import { Snapshot } from "../git/snapshot.js";
import type { AuditResult, FixOutcome } from "../orchestrator.js";
import { ReportSchema, type Report } from "../report/schema.js";
import { diffCommand } from "./diff.js";
import { retryCommand } from "./retry.js";
import { runCommand } from "./run.js";
import { showCommand } from "./show.js";
import { undoCommand } from "./undo.js";

const config = { maxLoops: 5, perIssueBudget: 3, maxSessions: 4 };

function badRunScopeAndTimeoutsReport(): Report {
  return ReportSchema.parse(
    JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../test/fixtures/reports/bad-run-scope-and-timeouts.json", import.meta.url)),
        "utf8",
      ),
    ),
  );
}

function reportWith(findings: Report["findings"]): Report {
  return {
    findings,
    secrets: findings.filter((f) => f.category === "secret"),
    reportOnly: findings.filter((f) => f.track === "report-only" && f.category !== "secret"),
    depBumps: findings
      .filter((f) => f.track === "deterministic" && f.remediation !== undefined)
      .map((f) => ({ findingId: f.id, remediation: f.remediation! })),
    flaggedBehaviorChanges: [],
    scannerStatuses: [],
    runScope: { type: "scoped" },
    fixPolicy: {
      includeTests: false,
      include: [],
      exclude: [],
      includeGenerated: false,
      includeFixtures: false,
    },
    aiUsage: {
      estimatedCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      sessions: 0,
    },
    failureSummary: {
      blockingSecrets: 0,
      unresolvedEligible: 0,
      toolFailures: 0,
      failedDeterministic: 0,
      sessionErrors: 0,
      regressions: 0,
      typecheckFailures: 0,
      testFailures: 0,
    },
    unresolvedEligibleCount: 0,
    loops: 1,
    durationMs: 10,
    exitStatus: 0,
  };
}

describe("runCommand", () => {
  it("T-111: run wires audit → fix → report (with fakes)", async () => {
    const finding = makeFinding({ tool: "sonarjs", file: "src/a.ts" });
    let n = 0;
    const audit = async (): Promise<AuditResult> => ({ findings: n++ === 0 ? [finding] : [] });
    const fixUnit = vi.fn(async (): Promise<FixOutcome> => ({ kept: true }));
    let t = 0;

    const { report, exitStatus } = await runCommand({ audit, fixUnit, config, now: () => (t += 10) });

    expect(exitStatus).toBe(0);
    expect(report.findings.find((f) => f.file === "src/a.ts")?.status).toBe("fixed");
    expect(report.durationMs).toBeGreaterThan(0);
  });
});

describe("diff / undo", () => {
  let repo: TmpRepo;
  beforeEach(async () => {
    repo = await tmpRepo();
  });
  afterEach(() => repo.cleanup());

  it("T-112: diff shows only the tool's edits", async () => {
    repo.write("a.ts", "A\n");
    await repo.commit("init");
    const snap = await Snapshot.capture(repo.git, repo.dir);
    writeFileSync(join(repo.dir, "a.ts"), "A_EDITED\n");

    expect(await diffCommand({ snapshot: snap, git: repo.git })).toStrictEqual(["a.ts"]);
  });

  it("T-113: undo restores the snapshot", async () => {
    repo.write("a.ts", "A\n");
    await repo.commit("init");
    const snap = await Snapshot.capture(repo.git, repo.dir);
    writeFileSync(join(repo.dir, "a.ts"), "A_EDITED\n");

    await undoCommand({ snapshot: snap, git: repo.git });

    expect(readFileSync(join(repo.dir, "a.ts"), "utf8")).toBe("A\n");
  });
});

describe("show", () => {
  it("T-114: show <id> prints finding detail (attempts, flow path)", () => {
    const finding = makeFinding({
      tool: "semgrep",
      rule: "sqli",
      category: "security",
      file: "src/api.ts",
      flowPath: [
        { file: "src/api.ts", line: 11 },
        { file: "src/api.ts", line: 14 },
      ],
    });
    finding.attempts = 3;
    finding.revertReason = "broke-test";
    finding.revertDetail = "Fix left previously-green test(s) red: api test";

    const out = showCommand(finding.id, [finding]);

    expect(out).toContain("attempts: 3");
    expect(out).toContain("broke-test");
    expect(out).toContain("last revert detail: Fix left previously-green test(s) red: api test");
    expect(out).toContain("src/api.ts:11");
    expect(out).toContain("src/api.ts:14");
  });

  it("shows a finding by retry id and prints both ids", () => {
    const finding = { ...makeFinding({ file: "src/a.ts" }), retryId: "kx7p2q" };

    const out = showCommand("kx7p2q", [finding]);

    expect(out).toContain("retry id: kx7p2q");
    expect(out).toContain(`fingerprint: ${finding.id}`);
    expect(out).toContain("src/a.ts:1");
  });
});

describe("retry", () => {
  it("T-115: retry <id> re-attempts with a larger budget", async () => {
    const finding = makeFinding({ file: "src/a.ts" });
    const runFix = vi.fn(async (_f: typeof finding, _budget: number): Promise<FixOutcome> => ({ kept: true }));

    await retryCommand(finding.id, { findings: [finding], baseBudget: 3, runFix });

    expect(runFix).toHaveBeenCalledOnce();
    const budgetUsed = runFix.mock.calls[0]?.[1];
    expect(budgetUsed).toBeGreaterThan(3);
  });

  it("retries a finding by retry id", async () => {
    const finding = { ...makeFinding({ file: "src/a.ts" }), retryId: "kx7p2q" };
    const runFix = vi.fn(async (_f: Report["findings"][number], _budget: number): Promise<FixOutcome> => ({ kept: true }));

    await retryCommand("kx7p2q", { findings: [finding], baseBudget: 3, runFix });

    expect(runFix).toHaveBeenCalledWith(finding, expect.any(Number));
  });

  it("rejects a missing finding id cleanly", async () => {
    const runFix = vi.fn(async (): Promise<FixOutcome> => ({ kept: true }));

    const result = await retryCommand("missing", { findings: [], baseBudget: 3, runFix });

    expect(result).toStrictEqual({ error: 'No finding with id "missing"' });
    expect(runFix).not.toHaveBeenCalled();
  });

  it("rejects an already fixed finding without running a fix", async () => {
    const finding = makeFinding({ file: "src/a.ts" });
    finding.status = "fixed";
    const runFix = vi.fn(async (): Promise<FixOutcome> => ({ kept: true }));

    const result = await retryCommand(finding.id, { findings: [finding], baseBudget: 3, runFix });

    expect(result).toStrictEqual({ error: `Finding ${finding.id} is already fixed` });
    expect(runFix).not.toHaveBeenCalled();
  });

  it("updates the report when retry fixes an unfixable finding", async () => {
    const finding = makeFinding({ file: "src/a.ts" });
    finding.status = "unfixable";
    finding.attempts = 3;
    finding.revertReason = "broke-test";
    finding.revertDetail = "Fix left a test red";
    const report = reportWith([finding]);

    const result = await retryCommand(finding.id, {
      report,
      baseBudget: 3,
      runFix: async (): Promise<FixOutcome> => ({ kept: true }),
    });

    expect(result).toMatchObject({ outcome: "fixed" });
    expect(report.findings[0]?.status).toBe("fixed");
    expect(report.findings[0]?.revertReason).toBeUndefined();
    expect(report.findings[0]?.revertDetail).toBeUndefined();
  });

  it("persists a reverted retry reason and increments attempts", async () => {
    const finding = makeFinding({ file: "src/a.ts" });
    finding.status = "reverted";
    finding.attempts = 2;
    const report = reportWith([finding]);

    const result = await retryCommand(finding.id, {
      report,
      baseBudget: 3,
      runFix: async (): Promise<FixOutcome> => ({ kept: false, reason: "typecheck" }),
    });

    expect(result).toMatchObject({ outcome: "reverted", reason: "typecheck" });
    expect(report.findings[0]?.status).toBe("reverted");
    expect(report.findings[0]?.attempts).toBe(3);
    expect(report.findings[0]?.revertReason).toBe("typecheck");
  });

  it("persists reverted retry detail", async () => {
    const finding = makeFinding({ file: "src/a.ts" });
    finding.status = "reverted";
    finding.attempts = 2;
    const report = reportWith([finding]);

    await retryCommand(finding.id, {
      report,
      baseBudget: 3,
      runFix: async (): Promise<FixOutcome> => ({
        kept: false,
        reason: "session-error",
        detail: "rate limited",
      }),
    });

    expect(report.findings[0]?.revertReason).toBe("session-error");
    expect(report.findings[0]?.revertDetail).toBe("rate limited");
  });

  it("returns an explicit ambiguity error for matching fingerprint prefixes", async () => {
    const a = {
      ...makeFinding({ file: "src/a.ts" }),
      id: "abcdef1111111111111111111111111111111111111111111111111111111111",
      retryId: "kx7p2q",
    };
    const b = {
      ...makeFinding({ file: "src/b.ts" }),
      id: "abcdef2222222222222222222222222222222222222222222222222222222222",
      retryId: "m8n4sa",
    };
    const runFix = vi.fn(async (): Promise<FixOutcome> => ({ kept: true }));

    const result = await retryCommand("abcdef", {
      findings: [a, b],
      baseBudget: 3,
      runFix,
    });

    expect(result).toStrictEqual({
      error:
        'Finding id "abcdef" is ambiguous; matches kx7p2q, m8n4sa. Use the retry id or full fingerprint.',
    });
    expect(runFix).not.toHaveBeenCalled();
  });

  it("keeps report-only jscpd findings out of secrets and retry dispatch", async () => {
    const report = badRunScopeAndTimeoutsReport();
    const reportOnly = report.findings.find((f) => f.retryId === "dupe01");
    expect(reportOnly).toBeDefined();

    expect(report.secrets).toHaveLength(0);
    expect(report.reportOnly.map((f) => f.id)).toContain(reportOnly?.id);
    expect(reportOnly).toMatchObject({
      track: "report-only",
      category: "duplication",
      tool: "jscpd",
    });

    const detail = showCommand("dupe01", report.findings);
    expect(detail).toContain("jscpd  duplicate-code  [pending]");
    expect(detail).toContain("src/components/SignupForm.ts:20");
    expect(detail).not.toContain("rotate");
    expect(detail).not.toContain("secret");

    const runFix = vi.fn(async (): Promise<FixOutcome> => ({ kept: true }));
    const result = await retryCommand("dupe01", {
      report,
      baseBudget: 3,
      runFix,
    });

    expect(result).toStrictEqual({ error: `Finding ${reportOnly?.id} is not AI-fixable` });
    expect(runFix).not.toHaveBeenCalled();
  });
});
