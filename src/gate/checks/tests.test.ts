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

  it("T-055: repair window exhausted (making progress each round), still red → reject", async () => {
    // Each repair shifts WHICH test is red — that counts as progress, so the loop runs the
    // full maxRepairs before rejecting (it does not short-circuit on no-progress).
    const multi = new Set(["t1", "t2", "t3"]);
    const runRelated = vi
      .fn()
      .mockResolvedValueOnce([fail("t1")])
      .mockResolvedValueOnce([fail("t2")])
      .mockResolvedValue([fail("t3")]);
    const repair = vi.fn().mockResolvedValue(undefined);
    const r = await runTestPhase({ baseline: multi, runRelated, repair, maxRepairs: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("broke-test");
    expect(repair).toHaveBeenCalledTimes(2);
  });

  it("T-055b: stuck gate (repair makes no progress) → short-circuits after ONE attempt", async () => {
    // Same regressed test red before and after the repair → no progress → stop immediately
    // instead of burning the remaining maxRepairs sessions on an unchanged gate.
    const runRelated = vi.fn().mockResolvedValue([fail("greenTest")]);
    const repair = vi.fn().mockResolvedValue(undefined);
    const r = await runTestPhase({ baseline, runRelated, repair, maxRepairs: 3 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("broke-test");
    expect(repair).toHaveBeenCalledTimes(1);
  });

  it("T-055c: repair that changes WHICH test is red (same count) is progress → no short-circuit", async () => {
    // T1 red → repair → T2 red: different names, same count. That's progress, so the loop
    // continues rather than stopping after the first attempt.
    const both = new Set(["t1", "t2"]);
    const runRelated = vi
      .fn()
      .mockResolvedValueOnce([fail("t1")])
      .mockResolvedValueOnce([fail("t2")])
      .mockResolvedValue([fail("t2")]);
    const repair = vi.fn().mockResolvedValue(undefined);
    const r = await runTestPhase({ baseline: both, runRelated, repair, maxRepairs: 3 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("broke-test");
    // attempt 1: t1→t2 (progress, continue); attempt 2: t2→t2 (no progress, stop).
    expect(repair).toHaveBeenCalledTimes(2);
  });

  it("runRelated rejects (runner crashed / unparseable report) → reject, never pass", async () => {
    const runRelated = vi.fn().mockRejectedValue(new Error("vitest wrote no JSON report (exit 1)"));
    const repair = vi.fn();
    const r = await runTestPhase({ baseline, runRelated, repair, maxRepairs: 3 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("session-error");
      expect(r.detail).toContain("Could not verify tests");
      expect(r.detail).toContain("vitest wrote no JSON report (exit 1)");
    }
    expect(repair).not.toHaveBeenCalled();
  });

  it("runRelated fails on the re-run inside the repair window → reject", async () => {
    const runRelated = vi
      .fn()
      .mockResolvedValueOnce([fail("greenTest")])
      .mockRejectedValue(new Error("runner crashed"));
    const repair = vi.fn().mockResolvedValue(undefined);
    const r = await runTestPhase({ baseline, runRelated, repair, maxRepairs: 3 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("session-error");
    expect(repair).toHaveBeenCalledTimes(1);
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
