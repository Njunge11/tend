import { describe, expect, it, vi } from "vitest";
import { makeFinding } from "../test/helpers/make-finding.js";
import type { Finding } from "./findings/finding.js";
import type { WorkUnit } from "./fixing/dispatch.js";
import { EventBus, type TendEvent } from "./output/events.js";
import { orchestrate, type AuditResult, type FixOutcome } from "./orchestrator.js";

const config = { maxLoops: 5, perIssueBudget: 3, maxSessions: 4 };

const ai = (file: string, rule = "r1", line = 1): Finding =>
  makeFinding({ tool: "sonarjs", file, rule, range: { startLine: line, startCol: 0, endLine: line, endCol: 1 } });

/** audit() that returns a scripted findings list per loop (1-indexed). */
function scriptedAudit(perLoop: Finding[][]): (loop: number) => Promise<AuditResult> {
  return async (loop) => ({ findings: perLoop[loop - 1] ?? [] });
}

const keep = async (_unit: WorkUnit, _loop: number): Promise<FixOutcome> => ({ kept: true });
const revert = async (_unit: WorkUnit, _loop: number): Promise<FixOutcome> => ({
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

  it("T-104: deterministic dep pass runs separately (no AI)", async () => {
    const dep = makeFinding({ tool: "osv", rule: "CVE-1", category: "vuln-dep", file: "package.json" });
    const audit = vi.fn(scriptedAudit([[dep, ai("src/a.ts")], []]));
    const fixUnit = vi.fn(keep);

    const res = await orchestrate({ audit, fixUnit, config });

    expect(res.depBumps).toHaveLength(1);
    expect(fixUnit.mock.calls.every((c) => c[0].file !== "package.json")).toBe(true);
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
    const fixUnit = vi.fn(revert);
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
  });

  it("T-127: --include-tests opts test files back in as fix targets", async () => {
    const audit = vi.fn(scriptedAudit([[ai("src/a.ts"), ai("src/inbound.test.ts")], []]));
    const fixUnit = vi.fn(keep);

    await orchestrate({ audit, fixUnit, config: { ...config, includeTests: true } });

    expect(fixUnit).toHaveBeenCalledTimes(2);
    const files = fixUnit.mock.calls.map((c) => c[0].file).sort();
    expect(files).toEqual(["src/a.ts", "src/inbound.ts"]); // inbound.ts owns its sibling test
  });

  it("T-128: a sibling test stays grouped with its code file (still editable during the fix)", async () => {
    // both the code file and its sibling test have findings → one unit, owner = code file
    const audit = vi.fn(scriptedAudit([[ai("src/a.ts"), ai("src/a.test.ts")], []]));
    const fixUnit = vi.fn(keep);

    await orchestrate({ audit, fixUnit, config });

    expect(fixUnit).toHaveBeenCalledTimes(1);
    const unit = fixUnit.mock.calls[0]?.[0];
    expect(unit?.file).toBe("src/a.ts");
    expect(unit?.files).toContain("src/a.test.ts"); // sibling reserved → editable, not dropped
  });
});
