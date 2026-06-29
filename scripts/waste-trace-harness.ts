/**
 * Empirical harness for items 1–3. It drives the REAL orchestrate() (the actual production
 * orchestration: deterministic concurrency, reactive split-fallback, retry budget, reconcile)
 * with the same EventBus+tracer wiring bin.ts uses, writing a trace per scenario under
 * TEND_TRACE_DIR. Only the AI session / gate outcome is scripted — the bugs being verified live
 * entirely in the orchestration, not the model. Each scenario reproduces the exact OLD waste and
 * the trace shows it is gone.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { orchestrate, type AuditResult, type FixOutcome } from "../src/orchestrator.js";
import { EventBus } from "../src/output/events.js";
import { createTracer } from "../src/debug/trace.js";
import { zeroUsage } from "../src/session/types.js";
import type { WorkUnit } from "../src/fixing/dispatch.js";
import { makeFinding } from "../test/helpers/make-finding.js";

const BASE = process.env.TEND_TRACE_DIR ?? join(tmpdir(), "tr");
const config = { maxLoops: 5, perIssueBudget: 3, maxSessions: 4, model: "claude-sonnet-4-6" };

function runWithTrace(
  dir: string,
  deps: { audit: AuditResult["findings"] extends never ? never : (loop: number) => Promise<AuditResult> } & Record<string, unknown>,
) {
  rmSync(dir, { recursive: true, force: true });
  const tracer = createTracer(dir)!;
  const bus = new EventBus();
  bus.on((e) => tracer.event(e));
  return orchestrate({ ...(deps as never), config, bus } as never);
}

const ai = (file: string, rule: string, line: number) =>
  makeFinding({ tool: "sonarjs", file, rule, range: { startLine: line, startCol: 0, endLine: line, endCol: 1 } });

async function scenario1() {
  // ITEM 1: deterministic units edit the real cwd behind a whole-project typecheck. The OLD bug
  // ran ~4 concurrently, so one unit's edit false-reverted a sibling's global tsc. We simulate that
  // exact failure: a unit reverts if ANY sibling is concurrently in-flight. At concurrency 1 no
  // sibling overlaps → every unit is kept (no false revert).
  const dir = join(BASE, "item1-deterministic-concurrency");
  const findings = Array.from({ length: 4 }, (_, i) =>
    makeFinding({ tool: "sonarjs", rule: "curly", file: `src/d${i}.ts`, autofixable: true }),
  );
  let active = 0;
  let maxActive = 0;
  const deterministicFixUnit = async (): Promise<FixOutcome> => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 10));
    // OLD bug reproduction: a concurrent sibling would have made this revert ("typecheck").
    const kept = active === 1;
    active--;
    return kept ? { kept: true, usage: zeroUsage() } : { kept: false, reason: "typecheck", failureClass: "typecheck", usage: zeroUsage() };
  };
  const res = await runWithTrace(dir, {
    audit: async (loop: number): Promise<AuditResult> => ({ findings: loop === 1 ? findings : [] }),
    fixUnit: async (): Promise<FixOutcome> => ({ kept: true }),
    deterministicFixUnit,
  });
  const fixed = res.findings.filter((f) => f.status === "fixed").length;
  console.log(`[item1] maxConcurrentDeterministic=${maxActive} (expect 1) · fixed=${fixed}/4 reverted=${4 - fixed} · trace=${dir}`);
}

async function scenario2() {
  // ITEM 2: a multi-finding AI batch reverts on typecheck because ONE finding is bad. The OLD bug
  // only split on tool-timeout/regression, so typecheck/broke-test reverted the whole batch (all 4
  // good siblings) every loop. Now it splits → the 3 good siblings each get a clean single attempt.
  const dir = join(BASE, "item2-batch-poison-split");
  const findings = [ai("src/big.ts", "r1", 1), ai("src/big.ts", "r2", 2), ai("src/big.ts", "r3", 3), ai("src/big.ts", "bad", 4)];
  const fixUnit = async (unit: WorkUnit): Promise<FixOutcome> => {
    if (unit.findings.length > 1) return { kept: false, reason: "typecheck", failureClass: "typecheck" };
    return unit.findings[0]?.rule === "bad"
      ? { kept: false, reason: "typecheck", failureClass: "typecheck", repairAttempted: true }
      : { kept: true };
  };
  const res = await runWithTrace(dir, {
    audit: async (loop: number): Promise<AuditResult> => ({ findings: loop === 1 ? findings : [findings[3]!] }),
    fixUnit,
  });
  const fixed = res.findings.filter((f) => f.status === "fixed").map((f) => f.rule).sort();
  console.log(`[item2] good siblings fixed=${JSON.stringify(fixed)} (expect r1,r2,r3) · bad reverted · trace=${dir}`);
}

async function scenario3() {
  // ITEM 3: a single-finding unit times out. The OLD bug kept tool-timeout in LIMITED_RETRY, so it
  // re-dispatched and timed out AGAIN next loop (double 10-min burn). Now a single-finding timeout
  // is terminal: attempted exactly once.
  const dir = join(BASE, "item3-single-finding-timeout");
  const lone = ai("src/lone.ts", "r1", 1);
  let calls = 0;
  const fixUnit = async (): Promise<FixOutcome> => {
    calls++;
    return { kept: false, reason: "session-error", detail: "AI session timed out after 3m", failureClass: "tool-timeout" };
  };
  const res = await runWithTrace(dir, {
    audit: async (): Promise<AuditResult> => ({ findings: [lone] }),
    fixUnit,
  });
  const f = res.findings[0]!;
  console.log(`[item3] fixUnit calls for the timed-out finding=${calls} (expect 1) · status=${f.status} attempts=${f.attempts} · trace=${dir}`);
}

await scenario1();
await scenario2();
await scenario3();
console.log("done");
