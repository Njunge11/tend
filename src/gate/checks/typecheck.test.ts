import { describe, expect, it, vi } from "vitest";
import { typecheck } from "./typecheck.js";

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
});
