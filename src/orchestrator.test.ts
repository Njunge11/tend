import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { makeFinding } from "../test/helpers/make-finding.js";
import type { Finding, Tool } from "./findings/finding.js";
import type { WorkUnit } from "./fixing/dispatch.js";
import { CAPABLE_MODEL, DEFAULT_MODEL } from "./fixing/model-selection.js";
import { EventBus, type TendEvent } from "./output/events.js";
import { applyOutcome, dispatchableUnits, orchestrate, type AuditResult, type FixOutcome } from "./orchestrator.js";
import { FindingStore } from "./findings/store.js";
import type { RepairPlan } from "./fixing/repair-strategy.js";
import { filesUnder } from "./git/repo.js";
import { filterToChanged } from "./scanners/scope.js";
import { tmpRepo } from "../test/helpers/tmp-repo.js";
import { ReportSchema } from "./report/schema.js";
import { zeroUsage } from "./session/types.js";

const config = { maxLoops: 5, perIssueBudget: 3, maxSessions: 4, model: DEFAULT_MODEL };

const ai = (file: string, rule = "r1", line = 1): Finding =>
  makeFinding({ tool: "sonarjs", file, rule, range: { startLine: line, startCol: 0, endLine: line, endCol: 1 } });

function badRunScopeAndTimeoutsFindings(): Finding[] {
  return ReportSchema.parse(
    JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../test/fixtures/reports/bad-run-scope-and-timeouts.json", import.meta.url)),
        "utf8",
      ),
    ),
  ).findings;
}

/** audit() that returns a scripted findings list per loop (1-indexed). */
function scriptedAudit(perLoop: Finding[][]): (loop: number) => Promise<AuditResult> {
  return async (loop) => ({ findings: perLoop[loop - 1] ?? [] });
}

const keep = async (_unit: WorkUnit, _loop: number): Promise<FixOutcome> => ({ kept: true });
// A non-gate failure: consumes the full per-issue budget (no in-dispatch repair already spent).
const revertSessionError = async (_unit: WorkUnit, _loop: number): Promise<FixOutcome> => ({
  kept: false,
  reason: "session-error",
});
// A gate failure: the in-dispatch repair already ran, so it's capped at the limited retry budget.
const revertGate = async (_unit: WorkUnit, _loop: number): Promise<FixOutcome> => ({
  kept: false,
  reason: "broke-test",
});

describe("orchestrate", () => {
  it("T-101 / T-102: audit → fix → re-audit → converged; re-audit runs once per loop", async () => {
    const audit = vi.fn(scriptedAudit([[ai("src/a.ts"), ai("src/b.ts"), ai("src/c.ts")], []]));
    const fixUnit = vi.fn(keep);

    const res = await orchestrate({ audit, fixUnit, config });

    expect(res.termination).toBe("converged");
    expect(res.exitStatus).toBe(0);
    // three files fixed in one batch → 3 fixUnit calls, but only 2 audits (initial + one re-audit)
    expect(fixUnit).toHaveBeenCalledTimes(3);
    expect(audit).toHaveBeenCalledTimes(2);
  });

  it("does not re-run a whole-repo scanner in loop 2+ when all its findings are out of fix scope (item 9)", async () => {
    // knip's only finding is in dist/ (generated → out of fix scope). tend never edits it, so
    // re-running knip's whole-repo scan every loop is wasted time. Loop 2 must re-run only sonarjs,
    // and the un-rescanned knip finding must NOT be misread as resolved.
    const source = ai("src/a.ts");
    const deadOut = makeFinding({ tool: "knip", rule: "unused-export", category: "dead-code", file: "dist/index.ts", message: "Unused export: foo" });
    const audit = vi.fn(async (loop: number, tools?: Tool[]): Promise<AuditResult> => {
      if (loop === 1) return { findings: [source, deadOut] };
      // Loop 2 should be asked for sonarjs only (knip is all out-of-scope).
      expect(tools).toEqual(["sonarjs"]);
      return { findings: [] };
    });

    const res = await orchestrate({ audit, fixUnit: vi.fn(keep), config });

    expect(audit).toHaveBeenCalledTimes(2);
    // The knip finding was never re-scanned, so it keeps its real (unresolved) state — not "fixed".
    expect(res.findings.find((f) => f.file === "dist/index.ts")).toMatchObject({
      inFixScope: false,
      status: "pending",
    });
  });

  it("keeps loop-1 scanner statuses for tools not re-audited in later loops", async () => {
    // Loop 2 re-audits only the tools that produced findings (sonarjs here), so its status
    // list is a subset. The final report must still carry gitleaks' clean loop-1 status.
    const audit = vi.fn(async (loop: number, tools?: Tool[]): Promise<AuditResult> => {
      if (loop === 1) {
        return {
          findings: [ai("src/a.ts")],
          scannerStatuses: [
            { tool: "sonarjs", status: "ran" },
            { tool: "gitleaks", status: "ran" },
          ],
        };
      }
      expect(tools).toEqual(["sonarjs"]);
      return {
        findings: [],
        scannerStatuses: [{ tool: "sonarjs", status: "failed", reason: "crashed on re-audit" }],
      };
    });

    const res = await orchestrate({ audit, fixUnit: vi.fn(keep), config });

    expect(audit).toHaveBeenCalledTimes(2);
    expect(res.scannerStatuses).toEqual([
      { tool: "sonarjs", status: "failed", reason: "crashed on re-audit" },
      { tool: "gitleaks", status: "ran" },
    ]);
  });

  it("T-103: secrets surfaced, excluded from fixes, exit non-zero, code fixes still proceed", async () => {
    const secret = makeFinding({ tool: "gitleaks", rule: "aws-key", category: "secret", file: "config/prod.ts" });
    const audit = vi.fn(scriptedAudit([[secret, ai("src/a.ts")], [secret]]));
    const fixUnit = vi.fn(keep);

    const res = await orchestrate({ audit, fixUnit, config });

    expect(res.secrets).toHaveLength(1);
    expect(res.exitStatus).toBe(1);
    // only the code file was dispatched, never the secret
    expect(fixUnit).toHaveBeenCalledTimes(1);
    expect(fixUnit.mock.calls[0]?.[0].file).toBe("src/a.ts");
  });

  it("plans cross-file jscpd as a multi-file unit", async () => {
    const duplicate = makeFinding({
      tool: "jscpd",
      rule: "duplicate-code",
      category: "duplication",
      file: "src/a.ts",
      flowPath: [
        { file: "src/a.ts", line: 1, range: { startLine: 1, startCol: 0, endLine: 15, endCol: 0 } },
        { file: "src/b.ts", line: 20, range: { startLine: 20, startCol: 0, endLine: 34, endCol: 0 } },
      ],
    });
    const audit = vi.fn(scriptedAudit([[duplicate], []]));
    const fixUnit = vi.fn(keep);

    const res = await orchestrate({ audit, fixUnit, config });

    expect(res.secrets).toHaveLength(0);
    expect(res.reportOnly).toHaveLength(0);
    expect(res.exitStatus).toBe(0);
    expect(fixUnit).toHaveBeenCalledOnce();
    expect(fixUnit.mock.calls[0]?.[0]).toMatchObject({
      file: "src/a.ts",
      files: ["src/a.ts", "src/b.ts", "src/_shared.ts"],
      strategy: "multi-file-duplicate-refactor",
    });
    expect(res.findings[0]?.repairStrategy).toBe("multi-file-duplicate-refactor");
  });

  it("reports cross-file jscpd duplicates excluded by scope without routing them to report-only", async () => {
    const duplicate = makeFinding({
      tool: "jscpd",
      rule: "duplicate-code",
      category: "duplication",
      file: "src/a.ts",
      flowPath: [
        { file: "src/a.ts", line: 1 },
        { file: "dist/b.ts", line: 20 },
      ],
    });
    const audit = vi.fn(scriptedAudit([[duplicate]]));
    const fixUnit = vi.fn(keep);

    const res = await orchestrate({ audit, fixUnit, config });

    expect(fixUnit).not.toHaveBeenCalled();
    expect(res.reportOnly).toHaveLength(0);
    expect(res.findings[0]).toMatchObject({
      track: "ai-fix",
      status: "pending",
      inReportScope: true,
      inFixScope: false,
      scopeExclusionReason: "generated",
      repairStrategy: "unsupported",
      repairStrategyReason: "generated",
    });
  });

  it("does not dispatch cross-file jscpd unless both clone files are in fix scope", async () => {
    const duplicate = makeFinding({
      tool: "jscpd",
      rule: "duplicate-code",
      category: "duplication",
      file: "src/a.ts",
      flowPath: [
        { file: "src/a.ts", line: 1 },
        { file: "src/b.ts", line: 20 },
      ],
    });
    const audit = vi.fn(scriptedAudit([[duplicate]]));
    const fixUnit = vi.fn(keep);

    const res = await orchestrate({
      audit,
      fixUnit,
      config,
      inScope: (findings) => filterToChanged(findings, ["src/a.ts"]),
    });

    expect(fixUnit).not.toHaveBeenCalled();
    expect(res.reportOnly).toHaveLength(0);
    expect(res.findings[0]).toMatchObject({
      track: "ai-fix",
      inScope: true,
      inFixScope: false,
      scopeExclusionReason: "out-of-scope",
      repairStrategy: "unsupported",
      repairStrategyReason: "out-of-scope",
    });
  });

  it("T-104: deterministic dep pass runs separately (no AI)", async () => {
    const dep = makeFinding({ tool: "osv", rule: "CVE-1", category: "vuln-dep", file: "package.json" });
    const audit = vi.fn(scriptedAudit([[dep, ai("src/a.ts")], []]));
    const fixUnit = vi.fn(keep);

    const res = await orchestrate({ audit, fixUnit, config });

    expect(res.depBumps).toHaveLength(1);
    expect(fixUnit.mock.calls.every((c) => c[0].file !== "package.json")).toBe(true);
  });

  it("an unused-file deletion obviates other findings on the same file (no wasted AI dispatch)", async () => {
    // The ajiri admin race: client.tsx is both knip-unused (→ deterministic delete) AND has a
    // sonarjs finding (→ AI fix). The delete must win and the sonarjs finding must NOT be sent to
    // an AI session (which would edit a sandbox copy then fail to apply to the deleted index entry).
    const deadFile = makeFinding({
      tool: "knip",
      rule: "unused-file",
      category: "dead-code",
      file: "src/dead.tsx",
      message: "Unused file: src/dead.tsx",
    });
    const sonarOnDead = ai("src/dead.tsx", "no-nested-assignment");
    const audit = vi.fn(scriptedAudit([[deadFile, sonarOnDead], []]));
    const fixUnit = vi.fn(keep);
    const deterministicFixUnit = vi.fn(keep);

    const res = await orchestrate({ audit, fixUnit, deterministicFixUnit, config });

    // No AI session is ever spawned for a file that was deleted out from under it.
    expect(fixUnit).not.toHaveBeenCalled();
    // The obviated finding is resolved, not left dangling as pending/unfixable.
    expect(res.findings.find((f) => f.id === sonarOnDead.id)?.status).toBe("fixed");
  });

  it("T-105: max-loops cap reached → stop, report remaining", async () => {
    // strictly-decreasing fixable counts so it never converges/stalls within the cap
    const audit = vi.fn(
      scriptedAudit([
        [ai("a.ts"), ai("b.ts"), ai("c.ts")],
        [ai("a.ts"), ai("b.ts")],
        [ai("a.ts")],
      ]),
    );
    const res = await orchestrate({ audit, fixUnit: vi.fn(keep), config: { ...config, maxLoops: 2 } });
    expect(res.termination).toBe("max-loops");
    expect(res.loops).toBe(2);
  });

  it("T-106: one stubborn issue is attempted until its per-issue budget is exhausted", async () => {
    const stubborn = ai("a.ts");
    const audit = vi.fn(async () => ({ findings: [stubborn] }));
    const fixUnit = vi.fn(revertSessionError);
    const events: TendEvent[] = [];
    const bus = new EventBus();
    bus.on((event) => events.push(event));

    const res = await orchestrate({ audit, fixUnit, config, bus });

    expect(res.termination).toBe("converged");
    expect(fixUnit).toHaveBeenCalledTimes(config.perIssueBudget);
    expect(res.findings.find((f) => f.file === "a.ts")?.attempts).toBe(config.perIssueBudget);
    expect(res.findings.find((f) => f.file === "a.ts")?.status).toBe("unfixable");
    expect(events.filter((event) => event.type === "loop-start")).toHaveLength(config.perIssueBudget);
    expect(events.filter((event) => event.type === "file-result")).toHaveLength(config.perIssueBudget);
  });

  it("T-106b: gate failures are capped at the limited retry budget, not the full per-issue budget", async () => {
    // broke-test/regression/typecheck already burned an in-dispatch repair before reverting, so the
    // orchestrator caps them at one re-dispatch (2 attempts) instead of perIssueBudget (3).
    const stubborn = ai("a.ts");
    const audit = vi.fn(async () => ({ findings: [stubborn] }));
    const fixUnit = vi.fn(revertGate);

    const res = await orchestrate({ audit, fixUnit, config });

    expect(res.termination).toBe("converged");
    expect(fixUnit).toHaveBeenCalledTimes(2);
    expect(res.findings.find((f) => f.file === "a.ts")?.attempts).toBe(2);
    expect(res.findings.find((f) => f.file === "a.ts")?.status).toBe("unfixable");
  });

  it("does not re-dispatch a gate failure whose in-dispatch repair already ran (item 5)", async () => {
    // The dispatch already burned an initial + repair session; re-dispatching repeats that fan-out.
    const stubborn = ai("a.ts");
    const audit = vi.fn(async () => ({ findings: [stubborn] }));
    const fixUnit = vi.fn(async (): Promise<FixOutcome> => ({
      kept: false,
      reason: "broke-test",
      failureClass: "broke-test",
      repairAttempted: true,
    }));

    const res = await orchestrate({ audit, fixUnit, config });

    // One dispatch only (without the fix it was capped at the limited-retry budget of 2).
    expect(fixUnit).toHaveBeenCalledOnce();
    expect(res.findings.find((f) => f.file === "a.ts")).toMatchObject({
      status: "unfixable",
      attempts: 1,
    });
  });

  it("aggregates estimated AI usage across fix outcomes, including reverted ones", async () => {
    const usage = (costUsd: number, inTok: number) => ({
      estimatedCostUsd: costUsd,
      inputTokens: inTok,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      sessions: 1,
    });
    // a.ts is kept; b.ts reverts once and (budget 1) becomes unfixable — both spend tokens.
    const audit = vi.fn(scriptedAudit([[ai("a.ts"), ai("b.ts")], [ai("b.ts")]]));
    const fixUnit = vi.fn(async (unit: WorkUnit): Promise<FixOutcome> =>
      unit.file === "a.ts"
        ? { kept: true, usage: usage(0.1, 100) }
        : { kept: false, reason: "broke-test", usage: usage(0.05, 50) },
    );

    const res = await orchestrate({ audit, fixUnit, config: { ...config, perIssueBudget: 1 } });

    expect(fixUnit).toHaveBeenCalledTimes(2);
    expect(res.usage.estimatedCostUsd).toBeCloseTo(0.15, 10);
    expect(res.usage.inputTokens).toBe(150);
    expect(res.usage.sessions).toBe(2);
  });

  it("stores session error detail on a reverted finding", async () => {
    const finding = ai("a.ts");
    const audit = vi.fn(scriptedAudit([[finding], [finding]]));
    const fixUnit = vi.fn(async (): Promise<FixOutcome> => ({
      kept: false,
      reason: "session-error",
      detail: "Claude exited non-zero: 1",
    }));

    const res = await orchestrate({ audit, fixUnit, config: { ...config, perIssueBudget: 1 } });

    expect(res.findings[0]?.status).toBe("unfixable");
    expect(res.findings[0]?.revertReason).toBe("session-error");
    expect(res.findings[0]?.revertDetail).toBe("Claude exited non-zero: 1");
  });

  it("splits a timed-out multi-finding unit before retrying and does not burn original attempts", async () => {
    const first = ai("src/a.ts", "r1", 1);
    const second = ai("src/a.ts", "r2", 2);
    const audit = vi.fn(scriptedAudit([[first, second], []]));
    const events: TendEvent[] = [];
    const bus = new EventBus();
    bus.on((event) => events.push(event));
    const fixUnit = vi.fn(async (unit: WorkUnit): Promise<FixOutcome> => {
      if (unit.findings.length > 1) {
        return {
          kept: false,
          reason: "session-error",
          detail: "Claude session failed (exit 143)",
          failureClass: "tool-timeout",
        };
      }
      return { kept: true };
    });

    const res = await orchestrate({ audit, fixUnit, config, bus });

    expect(fixUnit).toHaveBeenCalledTimes(3);
    expect(fixUnit.mock.calls.map((call) => call[0].findings.map((f) => f.rule))).toEqual([
      ["r1", "r2"],
      ["r1"],
      ["r2"],
    ]);
    expect(events.flatMap((event) => (event.type === "file-result" ? [event.outcome] : []))).toEqual([
      "left",
      "fixed",
      "fixed",
    ]);
    expect(res.findings.every((f) => f.attempts === 0)).toBe(true);
    expect(res.findings.every((f) => f.status === "fixed")).toBe(true);
  });

  it("does not re-attempt a single-finding timeout (re-patching identical input is pure waste)", async () => {
    // A multi-finding batch that times out splits into single-finding units (item 2). A
    // single-finding unit that itself times out has nothing left to reduce and nothing else
    // edits its file, so a cross-loop retry would re-feed identical input and time out again.
    // Such timeouts are terminal: one attempt, then unfixable — no second 10-minute timeout.
    const first = ai("src/a.ts", "r1", 1);
    const second = ai("src/a.ts", "r2", 2);
    const audit = vi.fn(scriptedAudit([[first, second], [first, second], [first, second]]));
    const fixUnit = vi.fn(async (): Promise<FixOutcome> => ({
      kept: false,
      reason: "session-error",
      detail: "Claude session failed (exit 143)",
      failureClass: "tool-timeout",
    }));

    const res = await orchestrate({ audit, fixUnit, config });

    // Loop 1: one multi-finding batch + two single-finding splits = 3 calls. The splits are
    // terminal, so no further loop re-dispatches them. (Without the fix this was 6 calls.)
    expect(fixUnit).toHaveBeenCalledTimes(3);
    expect(res.termination).toBe("converged");
    expect(res.findings).toHaveLength(2);
    expect(res.findings.every((f) => f.status === "unfixable")).toBe(true);
    expect(res.findings.every((f) => f.attempts === 1)).toBe(true);
    expect(res.findings.every((f) => f.finalFailureClass === "tool-timeout")).toBe(true);
  });

  it("a single-finding unit that times out is terminal after one attempt", async () => {
    const lone = ai("src/lone.ts", "r1", 1);
    const audit = vi.fn(scriptedAudit([[lone], [lone], [lone]]));
    const fixUnit = vi.fn(async (): Promise<FixOutcome> => ({
      kept: false,
      reason: "session-error",
      detail: "AI session timed out after 10m",
      failureClass: "tool-timeout",
    }));

    const res = await orchestrate({ audit, fixUnit, config });

    expect(fixUnit).toHaveBeenCalledTimes(1);
    expect(res.termination).toBe("converged");
    expect(res.findings[0]).toMatchObject({
      status: "unfixable",
      attempts: 1,
      finalFailureClass: "tool-timeout",
    });
  });

  it("splits a multi-finding unit that reverts on typecheck or broke-test (item 2)", async () => {
    // One bad finding in a shared batch fails the collective gate (typecheck/broke-test) and
    // would revert the whole unit. Splitting lets the good siblings get their own attempt.
    const good = ai("src/a.ts", "r1", 1);
    const bad = ai("src/a.ts", "r2", 2);
    // The culprit keeps being reported (so reconcile never calls it "fixed" by absence).
    const audit = vi.fn(scriptedAudit([[good, bad], [bad], [bad]]));
    const fixUnit = vi.fn(async (unit: WorkUnit): Promise<FixOutcome> => {
      if (unit.findings.length > 1) {
        return { kept: false, reason: "typecheck", detail: "tsc failed", failureClass: "typecheck" };
      }
      // Singles: the good one is kept; the culprit keeps failing typecheck.
      return unit.findings[0]?.rule === "r2"
        ? { kept: false, reason: "typecheck", detail: "tsc failed", failureClass: "typecheck" }
        : { kept: true };
    });

    const res = await orchestrate({ audit, fixUnit, config });

    // batch (r1,r2) reverts typecheck → split into r1, r2 singles; r1 is kept, r2 keeps failing.
    expect(fixUnit.mock.calls.slice(0, 3).map((c) => c[0].findings.map((f) => f.rule))).toEqual([
      ["r1", "r2"],
      ["r1"],
      ["r2"],
    ]);
    expect(res.findings.find((f) => f.rule === "r1")?.status).toBe("fixed");
    expect(res.findings.find((f) => f.rule === "r2")?.status).not.toBe("fixed");
  });

  it("runs deterministic units one at a time (no concurrent edits against the real cwd)", async () => {
    // Deterministic units edit the real cwd behind a whole-project typecheck; running them
    // concurrently let one unit's edit false-revert a sibling's global tsc (item 1).
    const findings = Array.from({ length: 4 }, (_, i) =>
      makeFinding({ tool: "knip", rule: "unused-export", category: "dead-code", file: `src/d${i}.ts`, message: `Unused export: x${i}` }),
    );
    const audit = vi.fn(scriptedAudit([findings, []]));
    let active = 0;
    let maxActive = 0;
    const deterministicFixUnit = vi.fn(async (): Promise<FixOutcome> => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { kept: true, usage: zeroUsage() };
    });

    const events: TendEvent[] = [];
    const bus = new EventBus();
    bus.on((event) => events.push(event));
    await orchestrate({ audit, fixUnit: vi.fn(keep), deterministicFixUnit, config, bus });

    expect(deterministicFixUnit).toHaveBeenCalledTimes(4);
    expect(maxActive).toBe(1);
    // the loop-start event reports the deterministic phase concurrency truthfully
    expect(events.find((e) => e.type === "loop-start")).toMatchObject({ concurrency: 1 });
  });

  it("marks a model-rejected (non-retryable) finding unfixable without burning the retry budget", async () => {
    const finding = ai("src/a.ts");
    const audit = vi.fn(scriptedAudit([[finding], [finding]]));
    const fixUnit = vi.fn(async (): Promise<FixOutcome> => ({
      kept: false,
      reason: "session-error",
      detail: "prompt is too long",
      failureClass: "model-rejected",
    }));

    const res = await orchestrate({ audit, fixUnit, config });

    // One attempt only: terminal, no-burn (attempts stays 0), never re-dispatched.
    expect(fixUnit).toHaveBeenCalledOnce();
    expect(res.findings[0]).toMatchObject({
      status: "unfixable",
      attempts: 0,
      finalFailureClass: "model-rejected",
    });
  });

  it("processes a large file's findings in bounded sequential batches (no oversized session)", async () => {
    const findings = Array.from({ length: 12 }, (_, i) => ai("src/big.ts", `r${i}`, i + 1));
    const audit = vi.fn(scriptedAudit([findings, []]));
    const sizes: number[] = [];
    const fixUnit = vi.fn(async (unit: WorkUnit): Promise<FixOutcome> => {
      sizes.push(unit.findings.length);
      return { kept: true };
    });

    const res = await orchestrate({ audit, fixUnit, config });

    expect(res.termination).toBe("converged");
    // 12 findings on one file → batches of 5, 5, 2 run sequentially; never one 12-finding session
    expect(sizes).toEqual([5, 5, 2]);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(5);
    expect(res.findings.every((f) => f.status === "fixed")).toBe(true);
  });

  it("a batch that still times out falls back to a reactive single-finding split", async () => {
    const findings = Array.from({ length: 6 }, (_, i) => ai("src/big.ts", `r${i}`, i + 1));
    const audit = vi.fn(scriptedAudit([findings, []]));
    const fixUnit = vi.fn(async (unit: WorkUnit): Promise<FixOutcome> => {
      if (unit.findings.length > 1) {
        return { kept: false, reason: "session-error", detail: "timed out", failureClass: "tool-timeout" };
      }
      return { kept: true };
    });

    const res = await orchestrate({ audit, fixUnit, config });

    // 6 findings → batches [5, 1]. The 5-batch times out → split into 5 singles (all fixed);
    // the trailing single-finding batch is fixed directly. 1 batch + 5 splits + 1 batch = 7 calls.
    expect(fixUnit.mock.calls.map((c) => c[0].findings.length)).toEqual([5, 1, 1, 1, 1, 1, 1]);
    expect(res.termination).toBe("converged");
    expect(res.findings.every((f) => f.status === "fixed")).toBe(true);
  });

  it("never chunks an atomic multi-file-duplicate-refactor unit", async () => {
    const duplicate = makeFinding({
      tool: "jscpd",
      rule: "duplicate-code",
      category: "duplication",
      file: "src/a.ts",
      flowPath: [
        { file: "src/a.ts", line: 1, range: { startLine: 1, startCol: 0, endLine: 15, endCol: 0 } },
        { file: "src/b.ts", line: 20, range: { startLine: 20, startCol: 0, endLine: 34, endCol: 0 } },
      ],
    });
    const audit = vi.fn(scriptedAudit([[duplicate], []]));
    const fixUnit = vi.fn(keep);

    await orchestrate({ audit, fixUnit, config });

    expect(fixUnit).toHaveBeenCalledOnce();
    expect(fixUnit.mock.calls[0]?.[0].strategy).toBe("multi-file-duplicate-refactor");
  });

  it("stops on rate limit with retryable infrastructure exit without consuming attempts", async () => {
    const finding = ai("src/a.ts");
    const audit = vi.fn(scriptedAudit([[finding], [finding]]));
    const fixUnit = vi.fn(async (): Promise<FixOutcome> => ({
      kept: false,
      reason: "session-error",
      detail: "Claude session rate-limited",
      failureClass: "rate-limit",
    }));

    const res = await orchestrate({ audit, fixUnit, config });

    expect(res.termination).toBe("retryable-infrastructure");
    expect(res.exitStatus).toBe(75);
    expect(fixUnit).toHaveBeenCalledOnce();
    expect(res.findings[0]).toMatchObject({
      status: "pending",
      attempts: 0,
      finalFailureClass: "rate-limit",
      revertDetail: "Claude session rate-limited",
    });
  });

  it("reports zero usage for a no-fix run", async () => {
    const audit = vi.fn(scriptedAudit([[]]));
    const res = await orchestrate({ audit, fixUnit: vi.fn(keep), config });
    expect(res.usage).toStrictEqual({
      estimatedCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      sessions: 0,
    });
  });

  it("runs deterministic fixes before AI and records zero AI sessions", async () => {
    const finding = makeFinding({
      tool: "sonarjs",
      rule: "curly",
      file: "src/a.ts",
      autofixable: true,
    });
    const audit = vi.fn(scriptedAudit([[finding], []]));
    const fixUnit = vi.fn(keep);
    const deterministicFixUnit = vi.fn(async (): Promise<FixOutcome> => ({
      kept: true,
      usage: {
        estimatedCostUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        sessions: 0,
      },
    }));

    const res = await orchestrate({ audit, fixUnit, deterministicFixUnit, config });

    expect(deterministicFixUnit).toHaveBeenCalledOnce();
    expect(fixUnit).not.toHaveBeenCalled();
    expect(res.usage.sessions).toBe(0);
    expect(res.findings[0]?.status).toBe("fixed");
  });

  it("does not silently fall back to AI when a deterministic fix fails", async () => {
    const finding = makeFinding({
      tool: "knip",
      rule: "unused-dependency",
      category: "dead-code",
      file: "package.json",
      message: "Unused dependency: jquery",
    });
    const audit = vi.fn(scriptedAudit([[finding], [finding]]));
    const fixUnit = vi.fn(keep);
    const deterministicFixUnit = vi.fn(async (): Promise<FixOutcome> => ({
      kept: false,
      reason: "needs-lockfile-update",
      detail: "package.json dependency cleanup requires a lockfile update",
      usage: {
        estimatedCostUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        sessions: 0,
      },
    }));

    const res = await orchestrate({
      audit,
      fixUnit,
      deterministicFixUnit,
      config: { ...config, perIssueBudget: 1 },
    });

    expect(deterministicFixUnit).toHaveBeenCalledOnce();
    expect(fixUnit).not.toHaveBeenCalled();
    expect(res.findings[0]).toMatchObject({
      status: "unfixable",
      revertReason: "needs-lockfile-update",
      revertDetail: "package.json dependency cleanup requires a lockfile update",
    });
    expect(res.usage.sessions).toBe(0);
  });

  it("T-108: oscillation is bounded by max loops", async () => {
    const audit = vi.fn(async (loop: number) => ({ findings: [loop % 2 === 1 ? ai("a.ts") : ai("b.ts")] }));
    const res = await orchestrate({ audit, fixUnit: vi.fn(keep), config: { ...config, maxLoops: 3 } });
    expect(res.termination).toBe("max-loops");
    expect(res.loops).toBe(3);
  });

  it("T-107: per-issue budget exhausted → mark that finding unfixable, continue others", async () => {
    const stubborn = ai("stubborn.ts");
    const easy = ai("easy.ts");
    const audit = vi.fn(scriptedAudit([[stubborn, easy], [stubborn], [stubborn]]));
    // easy is kept; stubborn always reverts
    const fixUnit = vi.fn(async (unit: WorkUnit, _loop: number): Promise<FixOutcome> =>
      unit.file === "easy.ts" ? { kept: true } : { kept: false, reason: "broke-test" },
    );

    const res = await orchestrate({ audit, fixUnit, config: { ...config, perIssueBudget: 2 } });

    expect(res.termination).toBe("converged"); // 0 fixable left (stubborn is unfixable)
    expect(res.findings.find((f) => f.file === "stubborn.ts")?.status).toBe("unfixable");
    expect(res.findings.find((f) => f.file === "stubborn.ts")?.attempts).toBe(2);
    expect(res.findings.find((f) => f.file === "easy.ts")?.status).toBe("fixed");
  });

  it("T-109: zero findings at start → exit clean immediately", async () => {
    const audit = vi.fn(scriptedAudit([[]]));
    const fixUnit = vi.fn(keep);
    const res = await orchestrate({ audit, fixUnit, config });
    expect(res.termination).toBe("converged");
    expect(res.exitStatus).toBe(0);
    expect(fixUnit).not.toHaveBeenCalled();
  });

  it("T-110: all scanners missing → error exit", async () => {
    const audit = vi.fn(async () => ({ findings: [], allScannersMissing: true }));
    const res = await orchestrate({ audit, fixUnit: vi.fn(keep), config });
    expect(res.termination).toBe("no-scanners");
    expect(res.exitStatus).toBe(1);
  });

  it("T-126: standalone test-file findings are excluded from fix scope by default", async () => {
    // src/inbound.test.ts has no sibling code finding → it's a primary fix target we must skip
    const audit = vi.fn(scriptedAudit([[ai("src/a.ts"), ai("src/inbound.test.ts")], []]));
    const fixUnit = vi.fn(keep);

    await orchestrate({ audit, fixUnit, config });

    expect(fixUnit).toHaveBeenCalledTimes(1);
    expect(fixUnit.mock.calls[0]?.[0].file).toBe("src/a.ts");
  });

  it("T-126b: all excluded test-file findings stop without dispatching empty loops", async () => {
    const audit = vi.fn(scriptedAudit([[ai("src/inbound.test.ts")], [ai("src/inbound.test.ts")]]));
    const fixUnit = vi.fn(keep);
    const events: TendEvent[] = [];
    const bus = new EventBus();
    bus.on((event) => events.push(event));

    const res = await orchestrate({ audit, fixUnit, config, bus });

    expect(res.termination).toBe("no-progress");
    expect(fixUnit).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === "loop-start")).toBe(false);
    expect(events.some((event) => event.type === "file-result")).toBe(false);
  });

  it("stops when all pending AI findings are outside fix scope", async () => {
    const audit = vi.fn(scriptedAudit([[ai("src/outside.ts")], [ai("src/outside.ts")]]));
    const fixUnit = vi.fn(keep);

    const res = await orchestrate({ audit, fixUnit, config, inScope: () => [] });

    expect(res.termination).toBe("no-progress");
    expect(fixUnit).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledTimes(1);
    expect(res.findings.find((f) => f.file === "src/outside.ts")?.inScope).toBe(false);
    expect(res.findings.find((f) => f.file === "src/outside.ts")?.inFixScope).toBe(false);
    expect(res.findings.find((f) => f.file === "src/outside.ts")?.scopeExclusionReason).toBe("out-of-scope");
  });

  it("reports generated and fixture findings but does not dispatch them to AI by default", async () => {
    const dist = ai("dist/index.d.ts");
    const fixture = ai("test/fixtures/sample.ts");
    const source = ai("src/a.ts");
    const audit = vi.fn(scriptedAudit([[dist, fixture, source], [dist, fixture]]));
    const fixUnit = vi.fn(keep);

    const res = await orchestrate({ audit, fixUnit, config });

    expect(fixUnit).toHaveBeenCalledTimes(1);
    expect(fixUnit.mock.calls[0]?.[0].file).toBe("src/a.ts");
    expect(res.findings.find((f) => f.file === "src/a.ts")?.inFixScope).toBe(true);
    expect(res.findings.find((f) => f.file === "src/a.ts")?.status).toBe("fixed");
    expect(res.findings.find((f) => f.file === "dist/index.d.ts")).toMatchObject({
      inReportScope: true,
      inFixScope: false,
      scopeExclusionReason: "generated",
      status: "pending",
    });
    expect(res.findings.find((f) => f.file === "test/fixtures/sample.ts")).toMatchObject({
      inReportScope: true,
      inFixScope: false,
      scopeExclusionReason: "fixtures",
      status: "pending",
    });
  });

  it("does not spend work on generated, fixture, or report-only findings from the bad-run fixture", async () => {
    const findings = badRunScopeAndTimeoutsFindings();
    const normalSource = findings.find((f) => f.retryId === "src001");
    const audit = vi.fn(
      scriptedAudit([
        findings,
        findings.filter((f) => f.id !== normalSource?.id),
      ]),
    );
    const fixUnit = vi.fn(keep);

    const res = await orchestrate({ audit, fixUnit, config });

    expect(fixUnit).toHaveBeenCalledOnce();
    expect(fixUnit.mock.calls[0]?.[0]).toMatchObject({
      file: "src/signup/validate.ts",
      strategy: "single-file-ai-edit",
    });
    expect(res.reportOnly).toHaveLength(1);
    expect(res.secrets).toHaveLength(0);
    expect(res.findings.find((f) => f.retryId === "dist01")).toMatchObject({
      inReportScope: true,
      inFixScope: false,
      scopeExclusionReason: "generated",
      status: "pending",
      attempts: 0,
    });
    expect(res.findings.find((f) => f.retryId === "fixt01")).toMatchObject({
      inReportScope: true,
      inFixScope: false,
      scopeExclusionReason: "fixtures",
      status: "pending",
      attempts: 0,
    });
    expect(res.findings.find((f) => f.retryId === "dupe01")).toMatchObject({
      track: "report-only",
      category: "duplication",
      status: "pending",
    });
    expect(res.findings.find((f) => f.retryId === "src001")).toMatchObject({
      inFixScope: true,
      status: "fixed",
    });
  });

  it("does not dispatch a generated finding without a source owner", async () => {
    const dist = ai("dist/index.d.ts");
    const audit = vi.fn(scriptedAudit([[dist]]));
    const fixUnit = vi.fn(keep);

    const res = await orchestrate({
      audit,
      fixUnit,
      config: { ...config, fix: { include: ["dist/index.d.ts"] } },
    });

    expect(fixUnit).not.toHaveBeenCalled();
    expect(res.findings.find((f) => f.file === "dist/index.d.ts")).toMatchObject({
      repairStrategy: "unsupported",
      repairStrategyReason: "generated-source-not-found",
    });
  });

  it("T-125: with a path scope, an out-of-scope finding is reported but not fixed", async () => {
    // Real path-scope pipeline: expand a directory to its files, then fix only findings under it.
    const repo = await tmpRepo();
    try {
      repo.write("apps/whatsapp/inbound.ts", "A\n");
      repo.write("apps/other/util.ts", "B\n");
      await repo.commit("init");

      const scope = await filesUnder(repo.git, ["apps/whatsapp"]);

      const inside = ai("apps/whatsapp/inbound.ts");
      const outside = ai("apps/other/util.ts");
      // Scanners report both files every loop; only the in-scope one should be dispatched.
      const audit = vi.fn(async (loop: number) => ({
        findings: [[inside, outside], [outside]][loop - 1] ?? [],
        scanned: scope.length,
      }));
      const fixUnit = vi.fn(keep);
      const events: TendEvent[] = [];
      const bus = new EventBus();
      bus.on((event) => events.push(event));

      const res = await orchestrate({
        audit,
        fixUnit,
        config,
        inScope: (fs) => filterToChanged(fs, scope),
        bus,
      });

      expect(fixUnit).toHaveBeenCalledTimes(1);
      expect(fixUnit.mock.calls[0]?.[0].file).toBe("apps/whatsapp/inbound.ts");
      const noExclusions = { tests: 0, generated: 0, fixtures: 0, outOfScope: 0, reportOnly: 0 };
      expect(events.filter((event) => event.type === "audit")).toEqual([
        { type: "audit", loop: 1, findings: 1, files: 1, scanned: 1, eligible: 1, excluded: noExclusions },
        { type: "audit", loop: 2, findings: 0, files: 0, scanned: 1, eligible: 0, excluded: noExclusions },
      ]);
      expect(res.findings.find((f) => f.file === "apps/whatsapp/inbound.ts")?.inScope).toBe(true);
      // The out-of-scope finding is still reported in the store, just tagged out of scope.
      expect(res.findings.find((f) => f.file === "apps/other/util.ts")?.inScope).toBe(false);
    } finally {
      repo.cleanup();
    }
  });

  it("audit event carries the eligibility funnel: eligible + per-reason exclusions", async () => {
    // a.test.ts is policy-excluded (tests, by default) — the audit event must say so up front.
    const audit = vi.fn(scriptedAudit([[ai("src/a.ts"), ai("src/a.test.ts")], []]));
    const fixUnit = vi.fn(keep);
    const events: TendEvent[] = [];
    const bus = new EventBus();
    bus.on((event) => events.push(event));

    await orchestrate({ audit, fixUnit, config, bus });

    const first = events.find((event) => event.type === "audit");
    expect(first).toMatchObject({
      findings: 2,
      eligible: 1,
      excluded: { tests: 1, generated: 0, fixtures: 0, outOfScope: 0, reportOnly: 0 },
    });
  });

  it("audit funnel and fix-pass denominator agree when a plan's strategy is unsupported", async () => {
    // A 6-line cross-file clone is below the refactor minimum, so planRepair marks it
    // unsupported/report-only and the dispatcher never attempts it. The audit event must
    // count it as excluded (not eligible), and the dispatched denominator must match.
    const smallClone: Finding = {
      ...makeFinding({
        tool: "jscpd",
        rule: "duplicate-code",
        category: "duplication",
        file: "src/git/repo.ts",
        range: { startLine: 28, startCol: 0, endLine: 33, endCol: 10 },
        flowPath: [
          { file: "src/git/repo.ts", line: 28, range: { startLine: 28, startCol: 0, endLine: 33, endCol: 10 } },
          { file: "src/git/client.ts", line: 80, range: { startLine: 80, startCol: 0, endLine: 85, endCol: 10 } },
        ],
      }),
    };
    const audit = vi.fn(scriptedAudit([[ai("src/a.ts"), smallClone], []]));
    const fixUnit = vi.fn(keep);
    const events: TendEvent[] = [];
    const bus = new EventBus();
    bus.on((event) => events.push(event));

    const res = await orchestrate({ audit, fixUnit, config, bus });

    const auditEvent = events.find((event) => event.type === "audit");
    expect(auditEvent).toMatchObject({
      findings: 2,
      eligible: 1,
      excluded: { tests: 0, generated: 0, fixtures: 0, outOfScope: 0, reportOnly: 1 },
    });
    // The same population reaches the dispatcher: 1 finding dispatched, 1 fix attempt.
    const loopStart = events.find((event) => event.type === "loop-start");
    expect(loopStart).toMatchObject({ findings: 1 });
    expect(fixUnit).toHaveBeenCalledTimes(1);
    // The never-attempted finding is not "unresolved eligible" and must not block exit 0.
    expect(res.exitStatus).toBe(0);
  });

  it("labels file-start with the capable model for a cognitive-complexity unit", async () => {
    // The fix-pass view shows each job's model from the file-start event; a complexity
    // refactor must display (and run on) the capable model, not the default.
    const complexity = ai("src/big.ts", "sonarjs/cognitive-complexity");
    const audit = vi.fn(scriptedAudit([[complexity, ai("src/plain.ts")], []]));
    const fixUnit = vi.fn(keep);
    const events: TendEvent[] = [];
    const bus = new EventBus();
    bus.on((event) => events.push(event));

    await orchestrate({ audit, fixUnit, config, bus });

    const starts = events.filter((event) => event.type === "file-start");
    expect(starts.find((event) => event.file === "src/big.ts")).toMatchObject({
      model: CAPABLE_MODEL,
    });
    expect(starts.find((event) => event.file === "src/plain.ts")).toMatchObject({
      model: config.model,
    });
  });

  it("T-127: --include-tests opts test files back in as fix targets", async () => {
    const audit = vi.fn(scriptedAudit([[ai("src/a.ts"), ai("src/inbound.test.ts")], []]));
    const fixUnit = vi.fn(keep);

    await orchestrate({ audit, fixUnit, config: { ...config, includeTests: true } });

    expect(fixUnit).toHaveBeenCalledTimes(2);
    const files = fixUnit.mock.calls.map((c) => c[0].file).sort();
    expect(files).toEqual(["src/a.ts", "src/inbound.ts"]); // inbound.ts owns its sibling test
  });

  it("T-128: an out-of-fix-scope sibling-test finding is not reserved into the source unit nor credited", async () => {
    // includeTests is off (default config), so the a.test.ts finding is out-of-fix-scope
    // (`unsupported`/"tests"). The source fix for a.ts must NOT reserve a.test.ts (no editing an
    // out-of-scope test) and must NOT count the report-only test finding as fixed. The legitimate
    // editable-sibling case (includeTests on → `test-file-repair`) is covered by T-127 above.
    const audit = vi.fn(scriptedAudit([
      [ai("src/a.ts"), ai("src/a.test.ts")],
      [ai("src/a.test.ts")], // a.ts fixed; the out-of-scope test finding persists, unaddressed
    ]));
    const fixUnit = vi.fn(keep);

    const res = await orchestrate({ audit, fixUnit, config });

    // only the source file is dispatched; the sibling test is not reserved into its unit
    expect(fixUnit).toHaveBeenCalledTimes(1);
    const unit = fixUnit.mock.calls[0]?.[0];
    expect(unit?.file).toBe("src/a.ts");
    expect(unit?.files).not.toContain("src/a.test.ts");
    // the out-of-fix-scope test finding is never marked fixed
    const testFinding = res.findings.find((f) => f.file === "src/a.test.ts");
    expect(testFinding?.inFixScope).toBe(false);
    expect(testFinding?.status).not.toBe("fixed");
  });
});

describe("dispatchableUnits — report-only plans never contaminate a dispatchable unit", () => {
  it("keeps an unsupported sibling-test plan out of the in-scope unit's files and findings", () => {
    const source = ai("src/x.ts");
    // A report-only duplicate in the sibling test: an `unsupported` plan with no editable files.
    // Pre-fix, `ownerFiles` expands [] → [test, ownerOf(test)=src/x.ts], so `mergeUnits` folds it
    // into the source unit — reserving the test and carrying its report-only finding.
    const test = makeFinding({ tool: "jscpd", rule: "duplicate-code", category: "duplication", file: "src/x.test.ts" });
    const plans: RepairPlan[] = [
      { finding: source, strategy: "single-file-ai-edit", editableFiles: ["src/x.ts"], verificationTargets: ["src/x.ts"] },
      { finding: test, strategy: "unsupported", editableFiles: [], verificationTargets: ["src/x.test.ts"], reason: "report-only" },
    ];

    const units = dispatchableUnits(plans);

    expect(units).toHaveLength(1);
    expect(units[0]?.files).toEqual(["src/x.ts"]); // NOT containing src/x.test.ts
    expect(units[0]?.findings).toEqual([source]); // only the in-scope finding
  });
});

describe("applyOutcome — never credit an out-of-fix-scope finding as fixed", () => {
  it("leaves an inFixScope:false finding pending on a kept outcome", () => {
    const store = new FindingStore();
    const inScopeF = ai("src/x.ts");
    const outOfScopeF = ai("src/x.test.ts", "r2");
    outOfScopeF.inFixScope = false; // report-only finding that hypothetically reached a kept unit
    store.add(inScopeF);
    store.add(outOfScopeF);
    const unit: WorkUnit = {
      file: "src/x.ts",
      files: ["src/x.ts", "src/x.test.ts"],
      findings: [inScopeF, outOfScopeF],
    };

    applyOutcome(store, unit, { kept: true }, config.perIssueBudget);

    expect(inScopeF.status).toBe("fixed");
    expect(outOfScopeF.status).toBe("pending"); // never credited as fixed
  });
});
