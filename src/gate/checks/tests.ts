import { pass, reject, type CheckResult } from "../check.js";

export type TestStatus = "pass" | "fail";
export type TestOutcome = { name: string; status: TestStatus };
type RunTests = () => Promise<TestOutcome[]>;

/** Run the suite once and record the names of tests that are green. */
export async function captureBaseline(run: RunTests): Promise<Set<string>> {
  const outcomes = await run();
  return new Set(outcomes.filter((o) => o.status === "pass").map((o) => o.name));
}

type TestEditKind = "structural" | "semantic";

const ASSERTION_RE = /\bexpect\s*\(|\.to(Be|Equal|StrictEqual|Match|Contain|Throw)|\bassert\b|\.should\b/;

/** Lines present in exactly one of the two versions (added or removed). */
function changedLines(before: string, after: string): string[] {
  const a = before.split("\n").map((l) => l.trim());
  const b = after.split("\n").map((l) => l.trim());
  const setA = new Set(a);
  const setB = new Set(b);
  return [...b.filter((l) => !setA.has(l)), ...a.filter((l) => !setB.has(l))];
}

/**
 * Classify a test edit: `structural` (imports/mocks/paths following a refactor —
 * allowed freely) vs `semantic` (a changed assertion/expected value — must be gated
 * and flagged for human review).
 */
export function classifyTestEdit(before: string, after: string): TestEditKind {
  const changed = changedLines(before, after).filter((l) => l.length > 0);
  return changed.some((l) => ASSERTION_RE.test(l)) ? "semantic" : "structural";
}

/** Run a test against arbitrary code, reporting whether it went green or red. */
type RunTestAgainst = (code: string, test: string) => Promise<TestStatus>;

/**
 * Anti oracle-corruption: an edited test must FAIL against the old (pre-fix) code.
 * If it passes on the old code too, it asserts nothing — a rubber stamp — so reject.
 */
export async function teethCheck(
  oldCode: string,
  editedTest: string,
  run: RunTestAgainst,
): Promise<CheckResult> {
  const status = await run(oldCode, editedTest);
  if (status === "fail") return pass();
  return reject("suppression", "Edited test passes on the old code — it has no teeth (rubber stamp)");
}

type TestPhaseResult = CheckResult & { warning?: string };

type RunTestPhaseDeps = {
  /** Tests green at the start of the run; only these count as regressions. */
  baseline: Set<string>;
  /** Run the related test(s) against the current working tree. */
  runRelated: RunTests;
  /** AI attempt to repair a red test (edits code and/or test), then we re-run. */
  repair: (attempt: number) => Promise<void>;
  /** Bound on repair attempts. */
  maxRepairs: number;
  /** False when the project has no test runner — gate degrades to a warning. */
  hasTestRunner?: boolean;
};

/** Baseline-green tests that are red now. */
function regressions(baseline: Set<string>, outcomes: TestOutcome[]): TestOutcome[] {
  return outcomes.filter((o) => o.status === "fail" && baseline.has(o.name));
}

/**
 * Apply→test→repair flow. A red previously-green test opens a bounded repair window
 * rather than an instant revert; exhausting it without going green is a reject.
 */
export async function runTestPhase(deps: RunTestPhaseDeps): Promise<TestPhaseResult> {
  if (deps.hasTestRunner === false) {
    return { ok: true, warning: "No test suite detected — behavior can't be verified" };
  }

  let regressed = regressions(deps.baseline, await deps.runRelated());
  if (regressed.length === 0) return pass();

  for (let attempt = 1; attempt <= deps.maxRepairs; attempt++) {
    await deps.repair(attempt);
    regressed = regressions(deps.baseline, await deps.runRelated());
    if (regressed.length === 0) return pass();
  }

  const names = regressed.map((o) => o.name).join(", ");
  return reject("broke-test", `Fix left previously-green test(s) red: ${names}`);
}
