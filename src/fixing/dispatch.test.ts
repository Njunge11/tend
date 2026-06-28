import { describe, expect, it } from "vitest";
import { makeFinding } from "../../test/helpers/make-finding.js";
import { chunkUnit, dispatch, planWork, planWorkFromRepairs } from "./dispatch.js";
import type { WorkUnit } from "./dispatch.js";

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

  it("coalesces all unused-file deletions into one atomic unit (no concurrent-delete race)", () => {
    const deadFiles = ["src/trpc/client.tsx", "src/trpc/server.tsx", "src/db/index.ts"];
    const plans = deadFiles.map((file) => ({
      finding: makeFinding({ tool: "knip", rule: "unused-file", category: "dead-code", file, message: `Unused file: ${file}` }),
      strategy: "deterministic-unused-file-delete" as const,
      editableFiles: [file],
      verificationTargets: [file],
    }));

    const units = planWorkFromRepairs(plans);

    expect(units).toHaveLength(1);
    expect(units[0]?.findings).toHaveLength(3);
    expect(new Set(units[0]?.files)).toStrictEqual(new Set(deadFiles));
    expect(units[0]?.strategy).toBe("deterministic-unused-file-delete");
  });

  it("does not merge unused-file deletions with unrelated deterministic units", () => {
    const units = planWorkFromRepairs([
      {
        finding: makeFinding({ tool: "knip", rule: "unused-file", category: "dead-code", file: "src/dead.ts", message: "Unused file: src/dead.ts" }),
        strategy: "deterministic-unused-file-delete",
        editableFiles: ["src/dead.ts"],
        verificationTargets: ["src/dead.ts"],
      },
      {
        finding: makeFinding({ tool: "sonarjs", rule: "sonarjs/x", file: "src/live.ts" }),
        strategy: "deterministic-eslint-fix",
        editableFiles: ["src/live.ts"],
        verificationTargets: ["src/live.ts"],
      },
    ]);

    expect(units).toHaveLength(2);
    expect(units.find((u) => u.strategy === "deterministic-unused-file-delete")?.files).toContain("src/dead.ts");
  });
});

describe("chunkUnit — bounded sequential batches", () => {
  const findingsFor = (file: string, count: number) =>
    Array.from({ length: count }, (_, i) =>
      makeFinding({ file, rule: `r${i}`, range: { startLine: i + 1, startCol: 0, endLine: i + 1, endCol: 1 } }),
    );
  const unitWith = (count: number, extra: Partial<WorkUnit> = {}): WorkUnit => ({
    file: "src/big.ts",
    files: ["src/big.ts", "src/big.test.ts"],
    findings: findingsFor("src/big.ts", count),
    ...extra,
  });

  it("returns the same unit reference (no copy) when findings fit in one batch", () => {
    const unit = unitWith(5);
    expect(chunkUnit(unit, 5)).toEqual([unit]);
    expect(chunkUnit(unit, 5)[0]).toBe(unit);
    expect(chunkUnit(unitWith(3), 5)).toHaveLength(1);
  });

  it("splits a large unit into sequential batches of at most batchSize", () => {
    const batches = chunkUnit(unitWith(25), 5);
    expect(batches).toHaveLength(5);
    expect(batches.map((b) => b.findings.length)).toEqual([5, 5, 5, 5, 5]);
    // every finding is covered exactly once, in order
    const rules = batches.flatMap((b) => b.findings.map((f) => f.rule));
    expect(rules).toEqual(findingsFor("src/big.ts", 25).map((f) => f.rule));
  });

  it("leaves a non-even remainder in a final smaller batch", () => {
    const batches = chunkUnit(unitWith(7), 5);
    expect(batches.map((b) => b.findings.length)).toEqual([5, 2]);
  });

  it("every batch keeps the unit's file set (so batches must run sequentially)", () => {
    const batches = chunkUnit(unitWith(12), 5);
    for (const batch of batches) {
      expect(batch.files).toEqual(["src/big.ts", "src/big.test.ts"]);
      expect(batch.file).toBe("src/big.ts");
    }
  });

  it("keeps atomic strategies whole — never split", () => {
    for (const strategy of ["multi-file-duplicate-refactor", "generated-source-repair"] as const) {
      const unit = unitWith(12, { strategy, strategies: [strategy] });
      expect(chunkUnit(unit, 5)).toEqual([unit]);
    }
  });

  it("treats batchSize < 1 as no chunking", () => {
    const unit = unitWith(12);
    expect(chunkUnit(unit, 0)).toEqual([unit]);
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

  it("skips units not yet started once the signal aborts — no outcome for them", async () => {
    const abort = new AbortController();
    const ran: string[] = [];
    const results = await dispatch(
      ["a", "b", "c", "d"].map(mkUnit),
      async (u) => {
        ran.push(u.file);
        abort.abort(); // cancel mid-run: only the first unit ever starts
        return u.file;
      },
      { concurrency: 1, signal: abort.signal },
    );
    expect(ran).toStrictEqual(["a"]);
    expect(results).toStrictEqual(["a"]);
  });

  it("runs everything when the signal never aborts", async () => {
    const abort = new AbortController();
    const results = await dispatch(["a", "b"].map(mkUnit), async (u) => u.file, {
      concurrency: 2,
      signal: abort.signal,
    });
    expect(results.sort()).toStrictEqual(["a", "b"]);
  });
});
