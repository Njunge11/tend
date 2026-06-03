import { describe, expect, it, vi } from "vitest";
import { captureBaseline, classifyTestEdit, runTestPhase, teethCheck } from "./tests.js";

const pass = (name: string) => ({ name, status: "pass" as const });
const fail = (name: string) => ({ name, status: "fail" as const });

describe("captureBaseline", () => {
  it("T-051: baseline records which tests are green at start", async () => {
    const run = vi.fn().mockResolvedValue([pass("a"), pass("b"), fail("c")]);
    const baseline = await captureBaseline(run);
    expect(baseline).toStrictEqual(new Set(["a", "b"]));
  });

  it("T-061: a pre-existing failing test is ignored (not in baseline)", async () => {
    const run = vi.fn().mockResolvedValue([pass("a"), fail("pre-existing-fail")]);
    const baseline = await captureBaseline(run);
    expect(baseline.has("pre-existing-fail")).toBe(false);
  });
});

describe("classifyTestEdit", () => {
  it("T-058: structural test edit (moved import) → allowed", () => {
    const before = ["import { sum } from './math';", "", "test('adds', () => {", "  expect(sum(1,2)).toBe(3);", "});"].join("\n");
    const after = ["", "test('adds', () => {", "  import { sum } from './math';", "  expect(sum(1,2)).toBe(3);", "});"].join("\n");
    expect(classifyTestEdit(before, after)).toBe("structural");
  });

  it("T-059: semantic test edit (changed assertion) → semantic", () => {
    const before = "test('adds', () => { expect(sum(1,2)).toBe(3); });";
    const after = "test('adds', () => { expect(sum(1,2)).toBe(4); });";
    expect(classifyTestEdit(before, after)).toBe("semantic");
  });
});

describe("teethCheck", () => {
  it("T-056: edited test FAILS on old code → pass (has teeth)", async () => {
    const run = vi.fn().mockResolvedValue("fail");
    const r = await teethCheck("OLD CODE", "EDITED TEST", run);
    expect(r).toStrictEqual({ ok: true });
    expect(run).toHaveBeenCalledWith("OLD CODE", "EDITED TEST");
  });

  it("T-057: edited test PASSES on old code → rubber stamp → reject", async () => {
    const run = vi.fn().mockResolvedValue("pass");
    const r = await teethCheck("OLD CODE", "EDITED TEST", run);
    expect(r.ok).toBe(false);
  });
});

describe("runTestPhase — apply / repair window", () => {
  const baseline = new Set(["greenTest"]);

  it("T-052: fix, related tests stay green, no test touched → pass", async () => {
    const runRelated = vi.fn().mockResolvedValue([pass("greenTest")]);
    const repair = vi.fn();
    const r = await runTestPhase({ baseline, runRelated, repair, maxRepairs: 3 });
    expect(r.ok).toBe(true);
    expect(repair).not.toHaveBeenCalled();
  });

  it("T-053: fix turns a previously-green test red, no repair → reject", async () => {
    const runRelated = vi.fn().mockResolvedValue([fail("greenTest")]);
    const repair = vi.fn();
    const r = await runTestPhase({ baseline, runRelated, repair, maxRepairs: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("broke-test");
    expect(repair).not.toHaveBeenCalled();
  });

  it("T-054: repair window — edits code, test goes green within N tries → pass", async () => {
    const runRelated = vi
      .fn()
      .mockResolvedValueOnce([fail("greenTest")])
      .mockResolvedValue([pass("greenTest")]);
    const repair = vi.fn().mockResolvedValue(undefined);
    const r = await runTestPhase({ baseline, runRelated, repair, maxRepairs: 3 });
    expect(r.ok).toBe(true);
    expect(repair).toHaveBeenCalledTimes(1);
  });

  it("T-055: repair window exhausted, still red → reject", async () => {
    const runRelated = vi.fn().mockResolvedValue([fail("greenTest")]);
    const repair = vi.fn().mockResolvedValue(undefined);
    const r = await runTestPhase({ baseline, runRelated, repair, maxRepairs: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("broke-test");
    expect(repair).toHaveBeenCalledTimes(2);
  });

  it("T-060: no test suite → degrades to pass with a warning", async () => {
    const runRelated = vi.fn();
    const repair = vi.fn();
    const r = await runTestPhase({
      baseline,
      runRelated,
      repair,
      maxRepairs: 3,
      hasTestRunner: false,
    });
    expect(r.ok).toBe(true);
    expect(r.warning).toBeDefined();
    expect(runRelated).not.toHaveBeenCalled();
  });
});
