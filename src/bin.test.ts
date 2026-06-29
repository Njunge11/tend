import { describe, expect, it } from "vitest";
import { makeFinding } from "../test/helpers/make-finding.js";
import { demoteFinalIntegrationFindings, parseTestReport } from "./bin.js";
import { captureBaseline, type TestOutcome } from "./gate/checks/tests.js";

/** A vitest/jest-shaped JSON report with one test file's worth of assertions. */
function report(assertions: { fullName: string; status: string }[]) {
  return { testResults: [{ assertionResults: assertions }] };
}

describe("parseTestReport", () => {
  it("maps passed→pass and failed→fail", () => {
    const outcomes = parseTestReport(
      report([
        { fullName: "a passes", status: "passed" },
        { fullName: "b fails", status: "failed" },
      ]),
    );
    expect(outcomes).toEqual<TestOutcome[]>([
      { name: "a passes", status: "pass" },
      { name: "b fails", status: "fail" },
    ]);
  });

  it("omits tests that did not run (skipped/pending/todo/disabled)", () => {
    const outcomes = parseTestReport(
      report([
        { fullName: "skipped", status: "skipped" },
        { fullName: "pending", status: "pending" },
        { fullName: "todo", status: "todo" },
        { fullName: "disabled", status: "disabled" },
      ]),
    );
    expect(outcomes).toEqual([]);
  });

  it("stays fail-closed for unrecognized statuses", () => {
    const outcomes = parseTestReport(report([{ fullName: "weird", status: "errored" }]));
    expect(outcomes).toEqual<TestOutcome[]>([{ name: "weird", status: "fail" }]);
  });

  it("a baseline-green test that skips at the gate is NOT a regression", async () => {
    // The bug: this test is green in main (dist/ present) but skips in the sandbox
    // worktree (dist/ absent). It must never be counted as a regression.
    const name = "real built worker — runs against dist";
    const baseline = await captureBaseline(async () =>
      parseTestReport(report([{ fullName: name, status: "passed" }])),
    );
    expect(baseline.has(name)).toBe(true);

    const gateOutcomes = parseTestReport(report([{ fullName: name, status: "skipped" }]));
    const regressed = gateOutcomes.filter((o) => o.status === "fail" && baseline.has(o.name));
    expect(regressed).toEqual([]);
  });

  it("a baseline-green test that genuinely fails at the gate IS a regression", async () => {
    const name = "really tests something";
    const baseline = await captureBaseline(async () =>
      parseTestReport(report([{ fullName: name, status: "passed" }])),
    );

    const gateOutcomes = parseTestReport(report([{ fullName: name, status: "failed" }]));
    const regressed = gateOutcomes.filter((o) => o.status === "fail" && baseline.has(o.name));
    expect(regressed).toEqual<TestOutcome[]>([{ name, status: "fail" }]);
  });
});

/** A fixed AI-track finding on `file`, the shape the orchestrator leaves after a kept unit. */
function fixedAiFinding(file: string) {
  const f = makeFinding({ file });
  f.status = "fixed";
  f.track = "ai-fix";
  return f;
}

describe("demoteFinalIntegrationFindings", () => {
  it("re-marks a fixed AI fix on a rolled-back file as final-integration-failed (no longer fixed)", () => {
    const finding = fixedAiFinding("src/a.ts");
    const demoted = demoteFinalIntegrationFindings([finding], ["src/a.ts"], "TS2769 in _shared.tsx");

    expect(demoted).toBe(1);
    expect(finding.status).toBe("unfixable");
    expect(finding.revertReason).toBe("final-integration-failed");
    expect(finding.finalFailureClass).toBe("final-integration-failed");
    expect(finding.revertDetail).toBe("TS2769 in _shared.tsx");
  });

  it("leaves a fixed finding on a file that was NOT rolled back untouched", () => {
    const finding = fixedAiFinding("src/kept.ts");
    const demoted = demoteFinalIntegrationFindings([finding], ["src/other.ts"], "detail");

    expect(demoted).toBe(0);
    expect(finding.status).toBe("fixed");
    expect(finding.finalFailureClass).toBeUndefined();
  });

  it("never demotes a deterministic fix — those are not rolled back", () => {
    const finding = fixedAiFinding("src/a.ts");
    finding.track = "deterministic";
    const demoted = demoteFinalIntegrationFindings([finding], ["src/a.ts"], "detail");

    expect(demoted).toBe(0);
    expect(finding.status).toBe("fixed");
  });

  it("ignores findings that were never fixed", () => {
    const finding = fixedAiFinding("src/a.ts");
    finding.status = "unfixable";
    const demoted = demoteFinalIntegrationFindings([finding], ["src/a.ts"], "detail");

    expect(demoted).toBe(0);
    // Untouched (no final-integration cause stamped over its real failure class).
    expect(finding.finalFailureClass).toBeUndefined();
  });

  it("matches a multi-file refactor via its flowPath even when finding.file was kept", () => {
    const finding = fixedAiFinding("src/primary.ts");
    finding.flowPath = [{ file: "src/shared.ts", line: 1 }];
    // Only the flowPath sibling was rolled back; the fix as a whole is undone, so demote it.
    const demoted = demoteFinalIntegrationFindings([finding], ["src/shared.ts"], "detail");

    expect(demoted).toBe(1);
    expect(finding.status).toBe("unfixable");
  });
});
