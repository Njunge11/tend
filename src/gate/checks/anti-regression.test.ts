import { describe, expect, it } from "vitest";
import { makeFinding } from "../../../test/helpers/make-finding.js";
import { antiRegression } from "./anti-regression.js";

const A = makeFinding({ file: "src/a.ts", rule: "r1", range: { startLine: 1, startCol: 0, endLine: 1, endCol: 1 } });
const B = makeFinding({ file: "src/a.ts", rule: "r2", range: { startLine: 9, startCol: 0, endLine: 9, endCol: 1 } });

describe("antiRegression", () => {
  it("T-045: reject — fix introduces a new finding", () => {
    const r = antiRegression([A], [A, B]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("regression");
  });

  it("T-046: happy — fix strictly reduces findings", () => {
    expect(antiRegression([A, B], [A])).toStrictEqual({ ok: true });
  });

  it("T-047: edge — net-neutral (resolve 1, add 1) → reject (no lateral move)", () => {
    const r = antiRegression([A], [B]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("regression");
  });

  it("rejects with 'unresolved-target' (not 'regression') when a target finding remains present", () => {
    // Distinct reason: nothing new was introduced, the edit just didn't clear its target. This
    // keeps it out of regression repair and lets the orchestrator cap its retries.
    const r = antiRegression([A], [A], { requireResolved: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("unresolved-target");
      expect(r.detail).toContain("Fix did not clear target finding");
    }
  });

  // A cross-file scanner (jscpd) reports a pre-existing clone that lives in the verification
  // scope but was never the unit's target. With the pre-fix baseline supplied, it must NOT be
  // treated as a regression — this is the bug that stalled the deterministic.ts fix loop.
  it("does not flag a pre-existing finding (in baseline) as introduced", () => {
    const preexisting = makeFinding({ tool: "jscpd", rule: "duplicate-code", category: "duplication", file: "src/other.test.ts" });
    const r = antiRegression([A], [A, preexisting], { baselineIds: new Set([A.id, preexisting.id]) });
    expect(r).toStrictEqual({ ok: true });
  });

  it("still rejects a genuinely new finding absent from the baseline", () => {
    const r = antiRegression([A], [A, B], { baselineIds: new Set([A.id]) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("regression");
  });

  it("baseline does not override requireResolved (target must still clear)", () => {
    const r = antiRegression([A], [A], { requireResolved: true, baselineIds: new Set([A.id]) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain("Fix did not clear target finding");
  });
});
