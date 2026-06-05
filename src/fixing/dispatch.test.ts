import { describe, expect, it } from "vitest";
import { makeFinding } from "../../test/helpers/make-finding.js";
import { dispatch, planWork, planWorkFromRepairs } from "./dispatch.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("planWork — group by file", () => {
  it("T-073: findings grouped by file", () => {
    const units = planWork([
      makeFinding({ file: "src/a.ts", rule: "r1", range: { startLine: 1, startCol: 0, endLine: 1, endCol: 1 } }),
      makeFinding({ file: "src/a.ts", rule: "r2", range: { startLine: 2, startCol: 0, endLine: 2, endCol: 1 } }),
      makeFinding({ file: "src/b.ts", rule: "r1", range: { startLine: 1, startCol: 0, endLine: 1, endCol: 1 } }),
    ]);

    expect(units).toHaveLength(2);
    expect(units.map((u) => u.file).sort()).toStrictEqual(["src/a.ts", "src/b.ts"]);
  });

  it("T-077: file with multiple findings → one session handles all of them", () => {
    const units = planWork([
      makeFinding({ file: "src/a.ts", rule: "r1", range: { startLine: 1, startCol: 0, endLine: 1, endCol: 1 } }),
      makeFinding({ file: "src/a.ts", rule: "r2", range: { startLine: 9, startCol: 0, endLine: 9, endCol: 1 } }),
    ]);

    expect(units).toHaveLength(1);
    expect(units[0]?.findings).toHaveLength(2);
  });

  it("T-074: each worker owns disjoint files (incl sibling test)", () => {
    const units = planWork([
      makeFinding({ file: "src/a.ts", rule: "r1", range: { startLine: 1, startCol: 0, endLine: 1, endCol: 1 } }),
      makeFinding({ file: "src/a.test.ts", rule: "r2", range: { startLine: 3, startCol: 0, endLine: 3, endCol: 1 } }),
      makeFinding({ file: "src/b.ts", rule: "r1", range: { startLine: 1, startCol: 0, endLine: 1, endCol: 1 } }),
    ]);

    // a.ts and its sibling a.test.ts belong to the SAME worker
    expect(units).toHaveLength(2);
    const aUnit = units.find((u) => u.file === "src/a.ts");
    expect(new Set(aUnit?.files)).toStrictEqual(new Set(["src/a.ts", "src/a.test.ts"]));

    // file ownership is pairwise disjoint across workers
    const all = units.flatMap((u) => u.files);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("planWorkFromRepairs", () => {
  it("creates one multi-file repair unit for a cross-file duplicate plan", () => {
    const finding = makeFinding({
      tool: "jscpd",
      rule: "duplicate-code",
      category: "duplication",
      file: "src/a.ts",
      flowPath: [
        { file: "src/a.ts", line: 1 },
        { file: "src/b.ts", line: 20 },
      ],
    });

    const units = planWorkFromRepairs([
      {
        finding,
        strategy: "multi-file-duplicate-refactor",
        editableFiles: ["src/a.ts", "src/b.ts"],
        verificationTargets: ["src/a.ts", "src/b.ts"],
      },
    ]);

    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      file: "src/a.ts",
      files: ["src/a.ts", "src/b.ts"],
      findings: [finding],
      strategy: "multi-file-duplicate-refactor",
      verificationTargets: ["src/a.ts", "src/b.ts"],
    });
  });
});

describe("dispatch — p-queue", () => {
  const mkUnit = (file: string) => ({ file, files: [file], findings: [makeFinding({ file })] });

  it("T-075: concurrency cap respected", async () => {
    let active = 0;
    let max = 0;
    const runUnit = async () => {
      active++;
      max = Math.max(max, active);
      await delay(10);
      active--;
      return "done";
    };

    await dispatch([mkUnit("a"), mkUnit("b"), mkUnit("c"), mkUnit("d")], runUnit, { concurrency: 2 });

    expect(max).toBeLessThanOrEqual(2);
  });

  it("T-076: more files than workers → excess queued (all still complete)", async () => {
    const files = ["a", "b", "c", "d", "e"].map(mkUnit);
    const results = await dispatch(files, async (u) => u.file, { concurrency: 2 });
    expect(results.sort()).toStrictEqual(["a", "b", "c", "d", "e"]);
  });
});
