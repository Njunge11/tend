import { describe, expect, it, vi } from "vitest";
import { parseTscErrors, typecheck } from "./typecheck.js";

describe("typecheck", () => {
  it("T-048: happy — fix that typechecks passes", async () => {
    const runTsc = vi.fn().mockResolvedValue({ exitCode: 0, output: "" });
    const r = await typecheck({ hasTsconfig: () => true, runTsc });
    expect(r).toStrictEqual({ ok: true });
    expect(runTsc).toHaveBeenCalledOnce();
  });

  it("T-049: reject — fix that breaks tsc --noEmit", async () => {
    const runTsc = vi.fn().mockResolvedValue({
      exitCode: 2,
      output: "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.",
    });
    const r = await typecheck({ hasTsconfig: () => true, runTsc });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("typecheck");
      expect(r.detail).toContain("TS2322");
    }
  });

  it("T-050: edge — no tsconfig → check skipped (pass)", async () => {
    const runTsc = vi.fn();
    const r = await typecheck({ hasTsconfig: () => false, runTsc });
    expect(r).toStrictEqual({ ok: true });
    expect(runTsc).not.toHaveBeenCalled();
  });

  it("T-051: baseline — a pre-existing error in an unedited file does NOT revert a clean fix", async () => {
    // The exact ajiri repro: fixing policy.ts, but a broken test fixture elsewhere already
    // fails tsc. With that error in the baseline, the gate must pass.
    const preexisting = "test/trpc-coverage.test.ts(132,44): error TS2322: Type '\"jobz\"' is not assignable to type '\"job\"'.";
    const runTsc = vi.fn().mockResolvedValue({ exitCode: 2, output: preexisting });
    const r = await typecheck({
      hasTsconfig: () => true,
      runTsc,
      baselineErrors: parseTscErrors(preexisting),
    });
    expect(r).toStrictEqual({ ok: true });
  });

  it("T-052: baseline — a NEW error the fix introduced still rejects, even with a baseline", async () => {
    const preexisting = "test/fixture.test.ts(10,5): error TS2322: Type 'A' is not assignable to type 'B'.";
    const afterFix = `${preexisting}\nsrc/policy.ts(8,3): error TS2554: Expected 1 arguments, but got 2.`;
    const runTsc = vi.fn().mockResolvedValue({ exitCode: 2, output: afterFix });
    const r = await typecheck({
      hasTsconfig: () => true,
      runTsc,
      baselineErrors: parseTscErrors(preexisting),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.detail).toContain("TS2554");
      expect(r.detail).not.toContain("TS2322"); // the pre-existing one is suppressed
    }
  });

  it("T-053: baseline — line-number shift of a pre-existing error is still treated as baseline", async () => {
    // The fix added lines above the fixture error, shifting it from line 132 to 140. The
    // signature ignores line/col, so it's still recognized as pre-existing.
    const baseline = parseTscErrors(
      "test/trpc-coverage.test.ts(132,44): error TS2322: Type '\"jobz\"' is not assignable to type '\"job\"'.",
    );
    const shifted = "test/trpc-coverage.test.ts(140,44): error TS2322: Type '\"jobz\"' is not assignable to type '\"job\"'.";
    const runTsc = vi.fn().mockResolvedValue({ exitCode: 2, output: shifted });
    const r = await typecheck({ hasTsconfig: () => true, runTsc, baselineErrors: baseline });
    expect(r).toStrictEqual({ ok: true });
  });

  it("T-054: baseline — a clean baseline ([]) rejects any post-fix error", async () => {
    const runTsc = vi.fn().mockResolvedValue({
      exitCode: 2,
      output: "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.",
    });
    const r = await typecheck({ hasTsconfig: () => true, runTsc, baselineErrors: [] });
    expect(r.ok).toBe(false);
  });

  it("T-055: baseline — tsc failing with no parseable diagnostics fails closed", async () => {
    // Timeout/crash: non-zero exit, empty output. Must reject, not silently pass.
    const runTsc = vi.fn().mockResolvedValue({ exitCode: 1, output: "" });
    const r = await typecheck({ hasTsconfig: () => true, runTsc, baselineErrors: [] });
    expect(r.ok).toBe(false);
  });

  it("T-056: baseline — adding a SECOND copy of a pre-existing error rejects (multiset)", async () => {
    const one = "src/a.ts(3,5): error TS2304: Cannot find name 'foo'.";
    const two = `${one}\nsrc/a.ts(9,5): error TS2304: Cannot find name 'foo'.`;
    const runTsc = vi.fn().mockResolvedValue({ exitCode: 2, output: two });
    const r = await typecheck({ hasTsconfig: () => true, runTsc, baselineErrors: parseTscErrors(one) });
    expect(r.ok).toBe(false);
  });
});
