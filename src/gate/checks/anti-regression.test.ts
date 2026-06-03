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
});
