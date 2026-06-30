#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { execa } from "execa";
import { buildProgram, type CliHandlers } from "./cli.js";
import { buildAudit, scanFiles, scannerAvailability } from "./scanners/all.js";
import { disposeEslintWorker } from "./scanners/eslint-sonarjs.js";
import { realSpawn, realWhich } from "./scanners/exec.js";
import { filterToChanged } from "./scanners/scope.js";
import { changedVsHead, filesUnder, assertGitRepo } from "./git/repo.js";
import { createGit } from "./git/client.js";
import { Snapshot } from "./git/snapshot.js";
import { detectPackageManager } from "./detect/package-manager.js";
import { detectTestRunner } from "./detect/test-runner.js";
import { detectTypeScript } from "./detect/typescript.js";
import { resolveOwnerRoot, toOwnerRelative } from "./detect/project-root.js";
import { makeFixUnit } from "./fixing/fix-unit.js";
import { thinkingEnv } from "./fixing/thinking-budget.js";
import { modelForUnit } from "./fixing/model-selection.js";
import { preflightModels } from "./fixing/model-preflight.js";
import { makeDeterministicFixUnit } from "./fixing/deterministic.js";
import { effortForUnit } from "./fixing/effort.js";
import { detectBuildCommand } from "./fixing/generated-source.js";
import { planWorkFromRepairs, type WorkUnit } from "./fixing/dispatch.js";
import type { Finding, Tool } from "./findings/finding.js";
import { isAiDispatchStrategy, planRepair } from "./fixing/repair-strategy.js";
import type { FixScopeConfig } from "./scanners/scope-policy.js";
import {
  mapOwnerRoot,
  pruneStaleWorktrees,
  SandboxSetupError,
  WorkerSandboxPool,
  type WorkerSandbox,
} from "./fixing/worker-sandbox.js";
import { onTerminationSignals } from "./process/signals.js";
import { ClaudeSession } from "./session/claude.js";
import { createStreamActivityScanner } from "./session/stream-activity.js";
import { runIncrementalTsc, tscCacheFile } from "./fixing/typecheck-cache.js";
import { expandWipFilesByImports } from "./fixing/wip-files.js";
import { parseTscErrors, typecheck } from "./gate/checks/typecheck.js";
import { orchestrate, type FixOutcome } from "./orchestrator.js";
import { ReportBuilder } from "./report/builder.js";
import { ReportSchema, type FinalIntegration, type Report } from "./report/schema.js";
import { renderSummary } from "./output/summary.js";
import { EventBus } from "./output/events.js";
import { createTracer, pointLatestAt, runId } from "./debug/trace.js";
import { detectOutputEnv } from "./output/env.js";
import { makeTheme } from "./output/theme.js";
import { createReporter } from "./output/reporter.js";
import { showCommand } from "./commands/show.js";
import { resolveRetryTarget, retryCommand } from "./commands/retry.js";
import {
  applyCliOverrides,
  loadConfig,
  EFFORT_LEVELS,
  type Effort,
} from "./config/config.js";
import type { TestOutcome } from "./gate/checks/tests.js";
import { reasonLabel } from "./output/format.js";
import { zeroUsage } from "./session/types.js";

// These reflect the directory tend operates from. They start at the process cwd but are rebased to
// the git repository root by `rebaseToRepoRoot()` at the start of every command (see below), because
// the whole pipeline — repo-root-relative paths, root-checkout AI sandboxes — assumes cwd == repo
// root. Hence `let`, not `const`.
let cwd = process.cwd();
// One id per process (== one run) shared by the tracer and the per-run report archive, so a
// run's trace dir (<TEND_TRACE_DIR>/<id>/) and report dir (.tend/runs/<id>/) carry the same id.
const RUN_ID = runId();
const tracer = createTracer(process.env.TEND_TRACE_DIR, RUN_ID);
let TEND_DIR = join(cwd, ".tend");
let SNAPSHOT_PATH = join(TEND_DIR, "snapshot.json");
let REPORT_PATH = join(TEND_DIR, "report.json");
let RUNS_DIR = join(TEND_DIR, "runs");
// tend-owned, outside any sandbox worktree → the tsc build-info survives worktree
// reset/clean and is reused across iterations (Fix 5).
let TEND_CACHE_DIR = join(TEND_DIR, "cache");

/**
 * Normalize tend to run from the git repository ROOT. The entire pipeline assumes cwd == repo root:
 * scope/finding paths are repo-root-relative (the git helpers strip the `--show-prefix`), and each
 * AI fix runs in a git WORKTREE — which git always roots at the repo top. Invoked from a subdirectory
 * (e.g. a monorepo package: `cd apps/dashboard && tend run lib/...`), `process.cwd()` is the subdir,
 * so every unit path is missing the `apps/dashboard/` prefix the sandbox checkout actually has. The
 * AI then edits the real file, but tend watches the prefix-less path, sees no change, and reverts the
 * fix as a no-op — silently landing zero fixes and burning sessions. Fix: `chdir` to the repo root up
 * front and rebase the module's `.tend` paths, so the rest of the command is byte-identical to a
 * root invocation. Returns `{ prefix, startCwd }` (prefix is "" at the root, a no-op) so a caller can
 * rebase user-supplied path arguments off the original cwd.
 */
async function rebaseToRepoRoot(): Promise<{ prefix: string; startCwd: string }> {
  const startCwd = process.cwd();
  const repoRoot = (await createGit(startCwd).revparse(["--show-toplevel"])).trim();
  const prefix = relative(repoRoot, startCwd);
  if (prefix === "") return { prefix, startCwd };
  process.chdir(repoRoot);
  cwd = repoRoot;
  TEND_DIR = join(cwd, ".tend");
  SNAPSHOT_PATH = join(TEND_DIR, "snapshot.json");
  REPORT_PATH = join(TEND_DIR, "report.json");
  RUNS_DIR = join(TEND_DIR, "runs");
  TEND_CACHE_DIR = join(TEND_DIR, "cache");
  return { prefix, startCwd };
}

// Upper bounds so a hung child can't stall the run forever — execa kills it on timeout.
// One cap for a single AI fix session. Used both to kill the `claude -p` subprocess and as the
// fix-unit session-timeout wrapper (passed below), so the enforced limit always matches the intent.
const CLAUDE_TIMEOUT_MS = Number(process.env.TEND_SESSION_TIMEOUT_MS) || 10 * 60_000;
const MODEL_PREFLIGHT_TIMEOUT_MS = 60_000;

/**
 * The role/system prompt shared by every fix session (`--append-system-prompt`). It owns the
 * GLOBAL rules so the per-strategy user prompts stay lean and only carry task-specific guidance —
 * Anthropic prompt guidance §10 (role) + §5/§7 (state global constraints once). Keep it short:
 * the model generalizes from the role, and the per-prompt success conditions still do the steering.
 */
const FIX_SYSTEM_PROMPT = [
  "You are a senior engineer making the smallest behavior-preserving change that clears a",
  "static-analysis finding. Fix the root cause; never mask a finding (no eslint-disable,",
  "@ts-ignore, @ts-nocheck, casts to `any`, `any` annotations, or weakened/skipped tests).",
  "Only edit the files you are given; if a correct fix needs a file you weren't given, leave",
  "the files unchanged. Make no unrelated refactors or formatting churn. The editable files'",
  "current contents are provided, so quote the exact lines you will change, then apply the fix",
  "with Write or Edit. Your change is accepted only if it clears the targeted findings on the",
  "verification targets, adds no new findings or suppressions, and leaves typecheck and tests",
  "green; a cosmetic or incomplete fix is reverted.",
].join(" ");
const BUILD_TIMEOUT_MS = 5 * 60_000;
const TSC_TIMEOUT_MS = 5 * 60_000;
const TEST_TIMEOUT_MS = 5 * 60_000;
const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : one + "s"}`;

function persist(path: string, value: unknown): void {
  mkdirSync(TEND_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

/** How many per-run report archives to keep under `.tend/runs/` before pruning the oldest. */
const RUNS_RETENTION = 50;

/**
 * Archive the run's report under `.tend/runs/<RUN_ID>/report.json` (history; `.tend/report.json`
 * stays the canonical latest, untouched here). Drops a `.tend/runs/latest` pointer at the newest
 * run and prunes the oldest archives past `RUNS_RETENTION` so the directory can't grow forever.
 * Best-effort: history is observability only and must never fail a run.
 */
function archiveReport(report: Report): void {
  try {
    const runDir = join(RUNS_DIR, RUN_ID);
    mkdirSync(runDir, { recursive: true });
    persist(join(runDir, "report.json"), report);
    pointLatestAt(RUNS_DIR, RUN_ID);
    pruneRunArchives();
  } catch {
    // never let history bookkeeping break a run
  }
}

/**
 * The oldest archive ids to drop so at most `retention` remain. runId is timestamp-prefixed, so
 * a lexicographic sort is chronological and the slice off the front is the oldest.
 */
export function runsToPrune(ids: readonly string[], retention: number): string[] {
  const sorted = [...ids].sort((a, b) => a.localeCompare(b));
  return sorted.slice(0, Math.max(0, sorted.length - retention));
}

/** Keep only the newest `RUNS_RETENTION` run archives; log which older ones were removed. */
function pruneRunArchives(): void {
  const ids = readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory()) // exclude the `latest` symlink
    .map((e) => e.name);
  const excess = runsToPrune(ids, RUNS_RETENTION);
  for (const id of excess) rmSync(join(RUNS_DIR, id), { recursive: true, force: true });
  if (excess.length > 0)
    out(`pruned ${plural(excess.length, "old run archive")} from .tend/runs (kept ${RUNS_RETENTION})`);
}

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function loadReport(): Report {
  if (!existsSync(REPORT_PATH))
    throw new Error("No .tend/report.json found. Run `tend run` first.");
  return ReportSchema.parse(loadJson<unknown>(REPORT_PATH));
}

/**
 * Decide whether capturing a fresh snapshot now would strand a still-live restore point.
 *
 * `.tend/snapshot.json` is the single pointer `tend undo` follows back to the pre-tend baseline.
 * Overwriting it is only dangerous when a previous run's edits are STILL PENDING on disk — i.e.
 * the developer ran tend, it kept some fixes, and they neither committed nor `tend undo`-ed
 * before running again. A fresh snapshot would then record run 1's edits as the baseline, so
 * `tend undo` could never reach the true original again.
 *
 * The precise signal is the count of last-run "fixed" files whose edit is still pending. tend
 * knows exactly which files it changed (the prior report's `fixed` findings); a fix is still
 * pending only when nothing was committed since the snapshot (HEAD still sits on the snapshot's
 * parent) AND the fixed file still differs from the snapshot (the edit is on disk, not undone).
 * This deliberately does NOT fire on a developer's own unrelated work, on fixes that were
 * committed (even if the file was later re-edited), or right after `tend undo`.
 */
export function snapshotOverwriteVerdict(input: {
  snapshotExists: boolean;
  priorFixedFilesPendingCount: number;
}): "safe" | "would-strand-baseline" {
  if (!input.snapshotExists) return "safe"; // nothing to overwrite
  if (input.priorFixedFilesPendingCount === 0) return "safe"; // prior fixes committed/undone/none
  return "would-strand-baseline";
}

/** Files a finding wrote to: its own file plus any flowPath siblings (multi-file refactors). */
function findingFiles(finding: Finding): string[] {
  return [finding.file, ...(finding.flowPath?.map((s) => s.file) ?? [])];
}

/** Repo-relative files the prior run kept edits on (status "fixed"), from `.tend/report.json`. */
function priorFixedFiles(): Set<string> {
  if (!existsSync(REPORT_PATH)) return new Set();
  try {
    const report = ReportSchema.parse(loadJson<unknown>(REPORT_PATH));
    const files = new Set<string>();
    for (const f of report.findings) {
      if (f.status === "fixed") for (const file of findingFiles(f)) files.add(file);
    }
    return files;
  } catch {
    return new Set(); // unreadable report — can't attribute edits, so don't block
  }
}

/**
 * Guard the per-run snapshot overwrite. Returns true when it's safe to capture a fresh
 * snapshot; on the dangerous case (a prior run's kept edits are still uncommitted) it prints
 * guidance and returns false so the caller aborts rather than silently stranding the baseline.
 * We refuse rather than silently keep the old snapshot: reusing a stale restore point could let
 * a later `tend undo` discard a developer's unrelated work, so the choice is left to them.
 */
async function snapshotOverwriteAllowed(git: ReturnType<typeof createGit>): Promise<boolean> {
  if (!existsSync(SNAPSHOT_PATH)) return true;
  const fixedFiles = priorFixedFiles();
  if (fixedFiles.size === 0) return true;
  let existing: Snapshot;
  try {
    existing = Snapshot.fromJSON(loadJson(SNAPSHOT_PATH));
  } catch {
    return true; // unreadable prior snapshot — nothing reliable to preserve
  }
  const [changed, parent, head] = await Promise.all([
    existing.changedSince(git),
    existing.parentSha(),
    git.revparse(["HEAD"]).then((s) => s.trim()).catch(() => null),
  ]);
  // Anything committed since the snapshot (HEAD moved off its parent) means the user resolved
  // the prior run — its baseline now lives in git history, so overwriting strands nothing.
  if (head !== parent) return true;
  // Otherwise a prior fix is still pending iff its file is still changed vs the snapshot (the
  // edit is on disk, not `tend undo`-ed away).
  const changedSet = new Set(changed);
  const pending = [...fixedFiles].filter((f) => changedSet.has(f));
  const verdict = snapshotOverwriteVerdict({
    snapshotExists: true,
    priorFixedFilesPendingCount: pending.length,
  });
  if (verdict === "safe") return true;
  err(
    "✖ Refusing to overwrite the previous run's restore point.\n" +
      `  A previous \`tend\` run's edits are still uncommitted on disk (${plural(pending.length, "file")}, e.g. ${pending[0]}).\n` +
      "  Capturing a new snapshot now would make `tend undo` stop at those edits instead of\n" +
      "  your original baseline, leaving the clean state unrecoverable.\n" +
      "    • To keep the edits:    commit (or stash) them, then run tend again.\n" +
      "    • To discard the edits: run `tend undo` to restore the baseline, then run tend again.",
  );
  return false;
}

// Unique JSON-report path per runTests invocation; concurrent gates never collide.
let testReportSeq = 0;

/** Assertion statuses meaning the test never executed, shared by vitest and jest. These
 *  are dropped, not scored: a test that didn't run is neither a pass nor a regression. */
const DID_NOT_RUN_STATUSES = new Set(["skipped", "pending", "todo", "disabled"]);

/** Shape shared by vitest's and jest's JSON reporters (the parts we read). */
type TestRunnerReport = {
  testResults?: {
    assertionResults?: {
      fullName?: string;
      title?: string;
      status: string;
    }[];
  }[];
};

/**
 * Parse a vitest/jest JSON report into per-test outcomes.
 *
 * A test that didn't run (a status in DID_NOT_RUN_STATUSES) is dropped, not scored: it can't
 * be a regression and must never enter the outcomes set. Skipping is environment-dependent
 * — e.g. `it.runIf(existsSync(dist/...))` is green in the main repo where dist/ exists but
 * skips in the sandbox worktree where it's absent. Folding a skip into "fail" would wrongly
 * flag a baseline-green test as regressed and revert a valid fix. Anything that isn't an
 * explicit pass or a recognized skip stays fail-closed (treated as "fail").
 */
export function parseTestReport(json: TestRunnerReport): TestOutcome[] {
  const outcomes: TestOutcome[] = [];
  for (const file of json.testResults ?? []) {
    for (const a of file.assertionResults ?? []) {
      if (DID_NOT_RUN_STATUSES.has(a.status)) continue;
      outcomes.push({
        name: a.fullName ?? a.title ?? "",
        status: a.status === "passed" ? "pass" : "fail",
      });
    }
  }
  return outcomes;
}

/**
 * Run the detected test runner over the given files and parse pass/fail per test.
 * `files` are repo-relative; `root` is the package that owns them (the cwd the runner
 * executes in). Files are re-based onto `root` so `vitest related` / `jest
 * --findRelatedTests` resolve them inside the owning package, not the repo root.
 *
 * The JSON report goes to a temp file (same pattern as jscpdReportPath): a test that
 * writes to stdout (console.log) interleaves noise with a stdout reporter and makes it
 * unparseable. A missing or unparseable report on a non-clean run THROWS — `[]` must
 * always mean "no related tests", or a fix that breaks tests passes the gate as if no
 * tests existed.
 */
async function runTests(
  runner: "vitest" | "jest",
  files: string[],
  root: string,
  repoRoot: string = cwd,
): Promise<TestOutcome[]> {
  const targets = toOwnerRelative(files, repoRoot, root);
  const reportFile = join(tmpdir(), `tend-tests-${process.pid}-${testReportSeq++}.json`);
  const args =
    runner === "vitest"
      ? ["vitest", "related", ...targets, "--run", "--reporter=json", `--outputFile=${reportFile}`]
      : ["jest", "--findRelatedTests", ...targets, "--json", `--outputFile=${reportFile}`, "--passWithNoTests"];
  const res = await execa("npx", args, {
    cwd: root,
    reject: false,
    timeout: TEST_TIMEOUT_MS,
  });
  try {
    if (!existsSync(reportFile)) {
      // Both runners write the report even when nothing relates (vitest exits 0 with an
      // empty report; jest gets --passWithNoTests). No report + clean exit → genuinely
      // no related tests. Anything else (crash, missing binary, timeout) is a failure.
      if (res.exitCode === 0) return [];
      const cause = res.timedOut
        ? `timed out after ${TEST_TIMEOUT_MS}ms`
        : `exit ${res.exitCode ?? "unknown"}`;
      const output = `${res.stderr ?? ""}\n${res.stdout ?? ""}`.trim().slice(0, 2000);
      throw new Error(`${runner} wrote no JSON report (${cause}):\n${output}`);
    }
    let json: TestRunnerReport;
    try {
      json = JSON.parse(readFileSync(reportFile, "utf8")) as TestRunnerReport;
    } catch (error) {
      throw new Error(
        `could not parse ${runner} JSON report: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return parseTestReport(json);
  } finally {
    rmSync(reportFile, { force: true });
  }
}

type TestRunner = "vitest" | "jest" | null;

type FinalIntegrationResult =
  // `findings` carries the new scanner findings surfaced by the post-run rescan that were NOT
  // auto-repaired. They are reported alongside the kept fixes, never a reason to revert.
  | { ok: true; files: string[]; findings?: Finding[] }
  | { ok: false; files: string[]; detail: string };

/** The slice of the gate deps the final-integration checks consume. */
type FinalIntegrationGate = {
  runTsc: () => Promise<{ exitCode: number; output: string }>;
  runRelated: (files: string[]) => Promise<TestOutcome[]>;
  scanFindings: (files: string[], tools?: Tool[]) => Promise<Finding[]>;
};

/** Failure detail when the final whole-run typecheck fails; undefined when clean or skipped.
 *  Uses the same pristine baseline as the per-unit gate, so a pre-existing tsc error doesn't
 *  fail the whole run after every accepted fix already typechecked clean against that baseline. */
async function finalTypecheckFailure(
  gate: FinalIntegrationGate,
  typescript: boolean,
  baselineErrors: readonly string[] | undefined,
): Promise<string | undefined> {
  if (!typescript) return undefined;
  const tc = await typecheck({ hasTsconfig: () => true, runTsc: gate.runTsc, baselineErrors });
  if (tc.ok) return undefined;
  return `final integration typecheck failed: ${tc.detail}`;
}

/** Failure detail when the final related-test run errors or fails; undefined when green or skipped. */
async function finalTestFailure(
  gate: FinalIntegrationGate,
  runner: TestRunner,
  files: string[],
): Promise<string | undefined> {
  if (!runner) return undefined;
  let tests: TestOutcome[];
  try {
    tests = await gate.runRelated(files);
  } catch (error) {
    return `final integration test run failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  const failed = tests.filter((test) => test.status === "fail");
  if (failed.length === 0) return undefined;
  return `final integration related tests failed: ${failed.map((test) => test.name).join(", ")}`;
}

/**
 * The final-integration gate failed and the run's AI edits were rolled back to the known-good
 * baseline. Re-mark every finding whose fix landed on a reverted file: it is no longer fixed on
 * disk, so report it as `final-integration-failed` (a couldn't-fix outcome) instead of leaving it
 * counted as fixed. Only `ai-fix` findings on a restored file are demoted — deterministic edits are
 * never rolled back. Returns the number demoted. Exported for testing.
 */
export function demoteFinalIntegrationFindings(
  findings: Finding[],
  restoredFiles: readonly string[],
  detail: string,
): number {
  const restored = new Set(restoredFiles);
  let demoted = 0;
  for (const f of findings) {
    if (f.status !== "fixed" || f.track !== "ai-fix") continue;
    const files = [f.file, ...(f.flowPath ?? []).map((step) => step.file)];
    if (!files.some((file) => restored.has(file))) continue;
    f.status = "unfixable";
    f.revertReason = "final-integration-failed";
    f.finalFailureClass = "final-integration-failed";
    f.revertDetail = detail;
    demoted += 1;
  }
  return demoted;
}

/**
 * The final-integration gate as a pure control-flow unit, with every effect injected so it is
 * testable in isolation. Runs the whole-run checks in order — typecheck → tests → scanner rescan —
 * short-circuiting on the first failure. When the rescan surfaces findings (a fix accepted during
 * the run introduced a NEW finding on a file it touched, e.g. an extracted shared module that
 * collides with a third file), it asks `repair` to fix them in place and re-verifies, capped at
 * `maxRepairRounds` rounds so an extract→new-clone→extract cycle always terminates.
 *
 * A fix that compiles and passes tests is NEVER reverted just because the rescan reports a new
 * finding: a new finding is information, not a broken build. So `ok: false` is returned ONLY when
 * `typecheckFailure` or `testFailure` is set; any findings the repair budget couldn't clear are
 * returned with `ok: true` and carried so the caller can report them. Exported for testing.
 */
export async function runFinalIntegration(deps: {
  acceptedFiles: () => string[];
  acceptedTools: () => Tool[];
  typecheckFailure: () => Promise<string | undefined>;
  testFailure: (files: string[]) => Promise<string | undefined>;
  scanFindings: (files: string[], tools: Tool[]) => Promise<Finding[]>;
  repair: (findings: Finding[]) => Promise<boolean>;
  maxRepairRounds?: number;
}): Promise<FinalIntegrationResult> {
  const maxRounds = deps.maxRepairRounds ?? 1;
  for (let round = 0; ; round++) {
    const files = deps.acceptedFiles().sort((a, b) => a.localeCompare(b));
    if (files.length === 0) return { ok: true, files };
    // Checks run in order and short-circuit: tests only run after a clean typecheck, the rescan
    // only after green tests — same sequencing as the per-unit gate.
    const blocker = (await deps.typecheckFailure()) ?? (await deps.testFailure(files));
    if (blocker) return { ok: false, files, detail: blocker };
    const tools = deps.acceptedTools();
    const findings = tools.length === 0 ? [] : await deps.scanFindings(files, tools);
    if (findings.length === 0) return { ok: true, files };
    // The fixes compiled and passed tests; a new scanner finding is not grounds to wipe them.
    // Try one in-place repair so a trivially-fixable surfaced finding is cleaned up, then report
    // whatever survives the repair budget — kept on disk, never reverted.
    if (round >= maxRounds || !(await deps.repair(findings))) return { ok: true, files, findings };
  }
}

async function makeProductionFixUnit(
  config: { model: string; effort?: Effort; thinkingBudget?: number; fix?: FixScopeConfig; includeTests?: boolean },
  baselineTargets: string[],
  // The package root that owns the scoped files. Detection (TypeScript/test runner),
  // the test baseline, typecheck, and related-test runs all execute here so a
  // path-scoped run inside a monorepo gates against the owning package, not the repo
  // root. Defaults to the repo cwd for whole-repo / root-package runs.
  ownerRoot: string = cwd,
  bus?: EventBus,
  detected?: { typescript: boolean; runner: TestRunner },
  sandboxPool?: WorkerSandboxPool,
  cancelSignal?: AbortSignal,
): Promise<{
  fixUnit: (unit: WorkUnit, loop: number) => Promise<FixOutcome>;
  deterministicFixUnit: (unit: WorkUnit, loop: number) => Promise<FixOutcome>;
  finalIntegration: () => Promise<FinalIntegrationResult>;
  typescript: boolean;
  runner: TestRunner;
}> {
  const typescript = detected?.typescript ?? detectTypeScript(ownerRoot);
  const runner = detected?.runner ?? detectTestRunner(ownerRoot) ?? null;
  const buildArgs = detectBuildCommand(ownerRoot);
  const pm = detectPackageManager(ownerRoot);
  let baseline = new Set<string>();
  if (runner && baselineTargets.length > 0) {
    try {
      baseline = new Set(
        (await runTests(runner, baselineTargets, ownerRoot, cwd))
          .filter((t) => t.status === "pass")
          .map((t) => t.name),
      );
    } catch (error) {
      // Degrading is safe here: an empty baseline only means no test counts as
      // "previously green", so the gate can't attribute regressions — its own
      // related-test runs still fail closed when the runner errors.
      err(
        `⚠ test baseline capture failed; continuing with an empty baseline: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  // Capture the pristine typecheck baseline: the tsc errors that ALREADY exist before any fix.
  // The gate rejects a fix only for errors not in this set, so a pre-existing error elsewhere in
  // the owning package's program (a broken test fixture, a half-finished sibling file) can't
  // false-revert a clean fix. `undefined` (capture threw) → the gate falls back to strict.
  let typecheckBaseline: readonly string[] | undefined;
  if (typescript) {
    try {
      const { output } = await runIncrementalTsc({
        exec: execa,
        cwd: ownerRoot,
        cacheFile: tscCacheFile(TEND_CACHE_DIR, cwd, ownerRoot, "baseline"),
        timeoutMs: TSC_TIMEOUT_MS,
      });
      typecheckBaseline = parseTscErrors(output);
    } catch (error) {
      err(
        `⚠ typecheck baseline capture failed; pre-existing tsc errors will fail closed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  // One reachability check per distinct model, memoized for the whole run. The primary
  // config.model is verified up front by the caller, so seed it as ready; capable-tier models
  // are checked lazily on first use (item 10).
  const modelChecks = new Map<string, Promise<{ ok: boolean; detail?: string }>>([
    [config.model, Promise.resolve({ ok: true })],
  ]);
  const ensureModelReady = (model: string): Promise<{ ok: boolean; detail?: string }> => {
    let check = modelChecks.get(model);
    if (!check) {
      check = preflightModels([model], pingModel).then((r) => {
        const result = r.ok ? { ok: true } : { ok: false, detail: r.failures[0]?.detail ?? "model unavailable" };
        bus?.emit({
          type: "debug",
          action: "model.preflight",
          detail: `lazily preflighted capable model "${model}": ${result.ok ? "ok" : "UNAVAILABLE"}`,
          data: { model, ok: result.ok, detail: result.detail },
        });
        return result;
      });
      modelChecks.set(model, check);
    }
    return check;
  };

  const makeGateDeps = (sandbox?: WorkerSandbox) => {
    const repoRoot = sandbox?.cwd ?? cwd;
    const gateOwnerRoot = sandbox ? mapOwnerRoot(cwd, ownerRoot, sandbox.cwd) : ownerRoot;
    const session = new ClaudeSession({
      spawn: async (req) => {
        const unitEffort = effortForUnit(req.findings, config.effort);
        const sessionModel = modelForUnit(req.findings, config);
        // Lazily verify a capable-tier model the first time a unit actually needs it. A bad
        // capable model fails just these units (a non-retryable, terminal "model rejected"
        // outcome — see parseStreamJson) instead of bricking the whole run or being pinged every
        // run up front (item 10). config.model was already verified up front by the caller.
        const ready = await ensureModelReady(sessionModel);
        if (!ready.ok) {
          const payload = JSON.stringify({
            type: "result",
            is_error: true,
            result: `Model "${sessionModel}" is not available: ${ready.detail}`,
          });
          return { stdout: payload, exitCode: 1 };
        }
        const startedAt = Date.now();
        const child = execa(
          "claude",
          [
            // Make the worker hermetic regardless of auth mode: no inherited MCP servers,
            // user CLAUDE.md, settings, hooks, or auto-memory — the worker must only ever
            // touch the files it is given inside its sandbox worktree.
            //   - API-key auth: `--bare` already disables all of the above (and requires an
            //     API key, so it cannot be used on OAuth).
            //   - OAuth/subscription auth: `--safe-mode` disables CLAUDE.md, skills, plugins,
            //     hooks, MCP, settings, and auto-memory while keeping OAuth auth, model
            //     selection, and the built-in Read/Write/Edit tools working normally.
            // `--strict-mcp-config` (with no `--mcp-config`) loads zero MCP servers on both
            // paths, and `--disallowedTools "mcp__*"` denies any MCP tool as defense in depth.
            ...(process.env.ANTHROPIC_API_KEY ? ["--bare"] : ["--safe-mode"]),
            "--strict-mcp-config",
            "--disallowedTools",
            "mcp__*",
            "--no-session-persistence",
            "-p",
            req.prompt,
            "--append-system-prompt",
            FIX_SYSTEM_PROMPT,
            "--model",
            sessionModel,
            "--effort",
            unitEffort,
            "--output-format",
            "stream-json",
            "--verbose",
            "--tools",
            "Read,Write,Edit",
            "--allowedTools",
            "Read,Write,Edit",
          ],
          {
            cwd: repoRoot,
            reject: false,
            timeout: CLAUDE_TIMEOUT_MS,
            cancelSignal: req.signal,
            // SIGKILL, not the default SIGTERM. `claude -p` ignores SIGTERM, so execa would fall
            // back to its `forceKillAfterDelay` escalation (~5s) — but that escalation is a JS
            // timer, and once a few un-killed sessions pile up they saturate the CPU and starve
            // the event loop, so every timer (the session cap AND the escalation) fires minutes
            // late. Sessions then ran for 30+ min against a 10-min cap. SIGKILL terminates on the
            // first (still-accurate) timeout with no second timer, so orphans never accumulate.
            killSignal: "SIGKILL",
            env: { ...process.env, ...thinkingEnv(req.findings, config) },
          },
        );
        // Surface live progress from the stream while the session runs. execa still
        // buffers the full stdout for the authoritative post-session parse — this
        // listener only decorates progress and must never affect the outcome.
        const scanner = createStreamActivityScanner((activity) => req.onActivity?.(activity));
        child.stdout?.on("data", (chunk: Buffer | string) => scanner.push(chunk.toString()));
        child.stdout?.on("end", () => scanner.end());
        const r = await child;
        // On timeout/kill exitCode is often undefined; preserve that as the conventional
        // SIGTERM exit so session classification can treat it as a tool timeout.
        let fallbackExit = 0;
        if (r.timedOut) fallbackExit = 143;
        else if (r.failed) fallbackExit = 1;
        const stdout = typeof r.stdout === "string" ? r.stdout : "";
        const exitCode = r.exitCode ?? fallbackExit;
        tracer?.session({
          file: req.file,
          model: sessionModel,
          effort: unitEffort,
          prompt: req.prompt,
          stdout,
          stderr: typeof r.stderr === "string" ? r.stderr : "",
          exitCode,
          timedOut: r.timedOut === true,
          durationMs: Date.now() - startedAt,
          findings: req.findings.map((f) => ({ tool: f.tool, rule: f.rule })),
        });
        return { stdout, exitCode };
      },
    });

    return {
      cwd: repoRoot,
      typescript,
      runTsc: async () =>
        // Cache the build-info in the MAIN repo's .tend/cache (never inside a sandbox
        // worktree) so it survives reset()/git clean and is reused across iterations. tsc
        // resolves the owning package's tsconfig from gateOwnerRoot, so semantics are
        // unchanged — only caching flags are added.
        runIncrementalTsc({
          exec: execa,
          cwd: gateOwnerRoot,
          // Discriminate by sandbox worktree so concurrent AI gates each get their own
          // build-info file instead of corrupting one shared cache (the non-sandbox
          // deterministic gate, which runs serially, keeps the stable per-owner path).
          cacheFile: tscCacheFile(TEND_CACHE_DIR, cwd, ownerRoot, sandbox?.cwd),
          timeoutMs: TSC_TIMEOUT_MS,
        }),
      runBuild: buildArgs
        ? async () => {
            const r = await execa(pm, buildArgs, {
              cwd: gateOwnerRoot,
              reject: false,
              timeout: BUILD_TIMEOUT_MS,
            });
            return {
              exitCode: r.exitCode ?? 1,
              output: `${r.stdout}\n${r.stderr}`,
            };
          }
        : undefined,
      hasTestRunner: Boolean(runner),
      runRelated: (files: string[]) =>
        runner ? runTests(runner, files, gateOwnerRoot, repoRoot) : Promise.resolve([]),
      scanFindings: async (files: string[], tools?: Tool[]) =>
        (
          await scanFiles(
            {
              cwd: repoRoot,
              which: realWhich,
              spawn: realSpawn,
              timeoutMs: 120_000,
              tools,
              tracer,
              tracePhase: "gate-rescan",
            },
            files,
            0,
          )
        ).findings,
      baseline,
      typecheckBaseline,
      session,
    };
  };

  const mainGateDeps = makeGateDeps();
  const acceptedFiles = new Set<string>();
  const acceptedTools = new Set<Tool>();
  const buildFixUnit = (sandbox?: WorkerSandbox) =>
    makeFixUnit({
      ...makeGateDeps(sandbox),
      maxRepairs: 3,
      // Share the one cap so the subprocess kill and the session-timeout wrapper never diverge.
      sessionTimeoutMs: CLAUDE_TIMEOUT_MS,
      cancelSignal,
      onProgress: (event) => bus?.emit({ type: "file-stage", ...event }),
    });

  const fixUnit = async (unit: WorkUnit, loop: number): Promise<FixOutcome> => {
    if (!sandboxPool) return buildFixUnit()(unit, loop);
    try {
      return await sandboxPool.withSandbox(unit, async (sandbox) => {
        const outcome = await buildFixUnit(sandbox)(unit, loop);
        if (!outcome.kept) return outcome;

        bus?.emit({ type: "file-stage", loop, file: unit.file, stage: "patch-apply" });
        const patch = await sandbox.collectPatch(unit);
        if (!patch.ok) {
          return {
            kept: false,
            reason: "unowned-patch",
            detail: patch.detail,
            failureClass: "unowned-patch",
            usage: outcome.usage,
          };
        }
        const applied = await sandboxPool.applyPatchToMain(patch.patch, patch.changedFiles);
        if (!applied.ok) {
          bus?.emit({ type: "file-stage", loop, file: unit.file, stage: "patch-conflict" });
          return {
            kept: false,
            reason: "patch-conflict",
            detail: applied.detail,
            failureClass: "patch-conflict",
            usage: outcome.usage,
          };
        }
        for (const file of patch.changedFiles) acceptedFiles.add(file);
        for (const finding of unit.findings) acceptedTools.add(finding.tool);
        return outcome;
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const setupFailed = error instanceof SandboxSetupError;
      return {
        kept: false,
        reason: setupFailed ? "sandbox-setup-failed" : "session-error",
        detail,
        failureClass: setupFailed ? "sandbox-setup-failed" : "model-tool-failure",
        usage: zeroUsage(),
      };
    }
  };

  // A fix accepted during the run can introduce a NEW finding on a file it touched — e.g.
  // extracting a shared module collides with a pre-existing block in a third (out-of-scope) file,
  // creating a fresh clone that only the whole-run rescan surfaces, after the loop. Rather than
  // discard every accepted fix, try ONCE to repair the newly-surfaced findings in place (the
  // duplicate planner collapses the new clone into the shared module). The repair is routed through
  // the same `fixUnit`/sandbox pool, so it forks from the already-fixed tree and its patch stacks
  // cleanly onto the accepted ones, and it gates itself (typecheck/tests/rescan) before applying —
  // a repair that can't land cleanly simply doesn't, and the caller still reverts to known-good.
  // Returns true when at least one unit landed a fix on disk (caller re-verifies); false when
  // nothing was AI-dispatchable or kept. Note this deliberately edits the clone's partner file even
  // when it sits outside the run's fix scope: the scope expansion is bounded to undoing the mess an
  // accepted in-scope fix made, and the alternative is throwing that fix away.
  const planConfig = { ...config.fix, includeTests: config.includeTests };
  const repairRescanFindings = async (findings: Finding[]): Promise<boolean> => {
    const plans = findings.map((finding) =>
      planRepair({
        finding,
        cwd,
        scope: finding,
        config: planConfig,
        flowPath: finding.flowPath,
        file: finding.file,
        category: finding.category,
        rule: finding.rule,
        tool: finding.tool,
      }),
    );
    const units = planWorkFromRepairs(plans.filter((plan) => isAiDispatchStrategy(plan.strategy)));
    if (units.length === 0) return false;
    bus?.emit({
      type: "debug",
      action: "final-integration.redispatch",
      detail: `repairing ${plural(units.length, "newly-surfaced unit")} before deciding rollback`,
      data: { files: [...new Set(units.flatMap((unit) => unit.files))] },
    });
    let kept = false;
    for (const unit of units) {
      if ((await fixUnit(unit, 0)).kept) kept = true;
    }
    return kept;
  };

  return {
    typescript,
    runner,
    fixUnit,
    deterministicFixUnit: makeDeterministicFixUnit(mainGateDeps),
    finalIntegration: () =>
      runFinalIntegration({
        acceptedFiles: () => [...acceptedFiles],
        acceptedTools: () => [...acceptedTools],
        typecheckFailure: () => finalTypecheckFailure(mainGateDeps, typescript, typecheckBaseline),
        testFailure: (files) => finalTestFailure(mainGateDeps, runner, files),
        scanFindings: (files, tools) => mainGateDeps.scanFindings(files, tools),
        repair: repairRescanFindings,
      }),
  };
}

function describeScopeNote(
  all: boolean | undefined,
  paths: string[],
  scope: string[] | null,
): string {
  if (all) return "whole repo";
  if (paths.length > 0)
    return `${plural(scope?.length ?? 0, "file")} under ${paths.join(", ")}`;
  return `${plural(scope?.length ?? 0, "changed file")}`;
}

/**
 * Resolve the fix scope for `tend run`: null = whole repo (`--all`); otherwise the concrete
 * file list — explicit path arguments expanded to files, or the files changed vs HEAD.
 * Returns undefined when the run should end here (empty path scope = error, clean tree =
 * success), with the message and exit code already reported.
 */
async function resolveRunScope(
  git: ReturnType<typeof createGit>,
  opts: { all?: boolean; paths?: string[] },
  reporter: ReturnType<typeof createReporter>,
): Promise<{ scope: string[] | null } | undefined> {
  const paths = opts.paths ?? [];
  if (opts.all) return { scope: null };
  if (paths.length > 0) {
    const scope = await filesUnder(git, paths);
    if (scope.length === 0) {
      err(`✖ no files under ${paths.join(", ")}`);
      process.exitCode = 1;
      return undefined;
    }
    return { scope };
  }
  const scope = await changedVsHead(git);
  if (scope.length === 0) {
    // A clean tree is a success, not an error (CI: nothing to fix → exit 0). Without this
    // early exit an empty scope fell through to scanner-specific whole-repo defaults.
    reporter.note("no files changed vs HEAD — nothing to scan. Use --all to fix the whole backlog or pass paths.");
    return undefined;
  }
  return { scope };
}

/** One `claude -p` reachability ping for a model (used by both the up-front and lazy preflights). */
async function pingModel(model: string): Promise<{ stdout: string; exitCode: number }> {
  const r = await execa(
    "claude",
    [
      ...(process.env.ANTHROPIC_API_KEY ? ["--bare"] : []),
      "--no-session-persistence",
      "-p",
      "Reply with: ok",
      "--model",
      model,
      "--max-turns",
      "1",
      "--output-format",
      "json",
    ],
    { reject: false, timeout: MODEL_PREFLIGHT_TIMEOUT_MS },
  );
  return { stdout: typeof r.stdout === "string" ? r.stdout : "", exitCode: r.exitCode ?? 1 };
}

/**
 * Probe the run's PRIMARY model up front. Capable-tier models (duplication/complexity escalation)
 * are NOT pinged here — most runs never route a unit to them, so pinging Opus every run was pure
 * waste (item 10). They're preflighted lazily on first use instead (see `ensureModelReady`).
 * Reports an unreachable model and returns false so the caller can abort before any work starts.
 */
async function verifyModelAccess(model: string): Promise<boolean> {
  const preflight = await preflightModels([model], pingModel);
  if (preflight.ok) return true;
  for (const failure of preflight.failures) err(`✖ model "${failure.model}": ${failure.detail}`);
  return false;
}

/**
 * Wrap the deterministic fix unit so each (no-AI) unit's attempt and resolution is recorded as a
 * `deterministic.unit` debug decision. Deterministic units have no `claude -p` session to capture
 * under sessions/, so this is the only trace of the deterministic phase's per-unit work.
 */
function traceDeterministicUnit(
  deterministicFixUnit: (unit: WorkUnit, loop: number) => Promise<FixOutcome>,
  bus: EventBus,
): (unit: WorkUnit, loop: number) => Promise<FixOutcome> {
  return async (unit, loop) => {
    const outcome = await deterministicFixUnit(unit, loop);
    const resolution = outcome.kept ? "kept" : `reverted (${outcome.reason ?? "?"})`;
    bus.emit({
      type: "debug",
      loop,
      action: "deterministic.unit",
      detail: `${unit.file} ${resolution}`,
      data: {
        file: unit.file,
        strategies: unit.strategies ?? (unit.strategy ? [unit.strategy] : []),
        findings: unit.findings.map((f) => `${f.tool}/${f.rule}`),
        kept: outcome.kept,
        reason: outcome.reason,
        detail: outcome.detail,
      },
    });
    return outcome;
  };
}

/** Project the gate result onto the report's `finalIntegration` shape, recording any surfaced
 *  rescan findings by identity (tool / rule / file / line) so a kept-but-flagged run is auditable.
 *  Exported for testing. */
export function toReportFinalIntegration(result: FinalIntegrationResult): FinalIntegration {
  if (!result.ok) return { ok: false, files: result.files, detail: result.detail, findings: [] };
  return {
    ok: true,
    files: result.files,
    findings: (result.findings ?? []).map((f) => ({
      tool: f.tool,
      rule: f.rule,
      file: f.file,
      line: f.range.startLine,
    })),
  };
}

/**
 * Individually-clean fixes combined into a tree that fails the final-integration gate. Leaving a
 * non-compiling tree breaks tend's core promise, so roll the run's AI edits back to the known-good
 * baseline and re-mark the affected findings as final-integration-failed (no longer fixed on disk).
 * The per-unit gate already gave each fix an error-grounded repair; the cross-unit interaction is
 * only visible here, where the safe action is revert-to-known-good. Sets `result.exitStatus = 1`.
 * Only typecheck/test failures reach here — a scanner-only rescan finding is reported, not reverted.
 */
function rollbackFailedIntegration(
  failure: Extract<FinalIntegrationResult, { ok: false }>,
  sandboxPool: WorkerSandboxPool,
  result: Awaited<ReturnType<typeof orchestrate>>,
  bus: EventBus,
): void {
  const detail = (failure.detail || "final integration failed").split("\n")[0] ?? "final integration failed";
  const restored = sandboxPool.rollbackMainChanges();
  const demoted = demoteFinalIntegrationFindings(result.findings, restored, detail);
  bus.emit({
    type: "debug",
    loop: result.loops,
    action: "final-integration.rollback",
    detail: `final integration failed → reverted ${restored.length} file(s) to known-good, ${demoted} fix(es) un-kept`,
    data: { files: restored, demoted, reason: failure.detail },
  });
  result.exitStatus = 1;
}

/**
 * Emit the run's context notes — toolchain/model, scope/scanner count, and (when a test runner
 * exists) the one-time baseline line. Pulled out of `runRun` to keep that orchestration function
 * within the cognitive-complexity budget; the output order is identical to the inline version.
 */
function reportRunContext(
  reporter: ReturnType<typeof createReporter>,
  ctx: {
    pm: string;
    typescript: boolean;
    runner: TestRunner;
    model: string;
    effort: Effort | undefined;
    availableCount: number;
    all: boolean | undefined;
    paths: string[];
    scope: string[] | null;
    baselineTargets: string[];
  },
): void {
  const modelLabel = ctx.effort ? `${ctx.model} (effort ${ctx.effort})` : ctx.model;
  reporter.note(
    `${ctx.pm} · ${ctx.typescript ? "TypeScript" : "JavaScript"} · ${ctx.runner ?? "no test runner"} · ${modelLabel}`,
  );
  const scopeNote = describeScopeNote(ctx.all, ctx.paths, ctx.scope);
  reporter.note(`${scopeNote} · ${plural(ctx.availableCount, "scanner")}`);
  if (ctx.runner && ctx.baselineTargets.length > 0) {
    reporter.note(
      `baseline: ${ctx.runner} related ${describeScopeNote(ctx.all, ctx.paths, ctx.scope)} (one-time)`,
    );
  }
}

async function runRun(opts: Parameters<CliHandlers["run"]>[0]): Promise<void> {
  // Resolve color/interactivity once, then paint the header immediately so the screen is
  // never blank while we take the snapshot. (`--no-color` arrives from commander as color:false.)
  const env = detectOutputEnv({
    stream: process.stdout,
    env: process.env,
    plain: opts.plain,
    noColor: opts.color === false,
  });
  const theme = makeTheme(env);
  const reporter = createReporter({ env, theme, write: out });
  reporter.start();
  const bus = new EventBus();
  bus.on((e) => reporter.onEvent(e));
  if (tracer) bus.on((e) => tracer.event(e));

  await assertGitRepo(createGit(process.cwd()));
  // Run from the repo root even when invoked inside a subdirectory (monorepo package), and rebase
  // the user's path arguments off the original cwd so they still point where they meant.
  const { prefix, startCwd } = await rebaseToRepoRoot();
  if (prefix && opts.paths?.length) {
    opts.paths = opts.paths.map((p) => relative(cwd, resolve(startCwd, p)));
  }
  const git = createGit(cwd);

  if (
    opts.effort &&
    !(EFFORT_LEVELS as readonly string[]).includes(opts.effort)
  ) {
    err(
      `✖ invalid --effort "${opts.effort}" (expected: ${EFFORT_LEVELS.join(" | ")})`,
    );
    process.exitCode = 1;
    return;
  }

  const config = applyCliOverrides(await loadConfig(cwd), {
    maxLoops: opts.maxLoops,
    maxSessions: opts.maxSessions,
    model: opts.model,
    effort: opts.effort as Effort | undefined,
    includeTests: opts.includeTests,
  });

  // Resolve the fix scope once and feed it to everything downstream (test baseline, audit,
  // fix filter). Resolved BEFORE the snapshot so a no-op run (nothing changed) exits without
  // touching anything.
  const paths = opts.paths ?? [];
  const resolved = await resolveRunScope(git, opts, reporter);
  if (!resolved) return;
  const { scope } = resolved;

  // Refuse to clobber a still-live restore point (uncommitted edits from a prior run) before
  // spending anything — cheaper than the model ping below, and never strands the baseline.
  if (!(await snapshotOverwriteAllowed(git))) {
    process.exitCode = 1;
    return;
  }

  // Verify every model this run can route to before doing any work. `claude -p`
  // exits 0 for an unknown model, so without this a typo'd --model silently burns
  // entire fix passes as no-op session errors (see model-preflight.ts).
  reporter.note("verifying model access…");
  if (!(await verifyModelAccess(config.model))) {
    process.exitCode = 1;
    return;
  }

  const snapshot = await Snapshot.capture(git, cwd);
  persist(SNAPSHOT_PATH, snapshot.toJSON());
  reporter.note("snapshot saved · undo: tend undo");

  const { available, missing } = await scannerAvailability(realWhich);
  if (available.length === 0) {
    err(`No scanners found. Install at least one of: ${missing.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  if (missing.length > 0)
    reporter.note(`skipping missing external scanners: ${missing.join(", ")}`);

  // Capture the pristine test baseline (which tests are green before any fix), scoped to the
  // files we'll touch. Relating against "." runs the whole suite and can take many minutes.
  const baselineTargets = scope ?? ["."];
  // For a path-scoped run, resolve the package that owns the scoped files and gate against
  // it. Whole-repo runs (`--all`, scope === null) stay rooted at the repo cwd.
  const ownerRoot = scope ? resolveOwnerRoot(cwd, scope) : cwd;
  const typescript = detectTypeScript(ownerRoot);
  const runner = detectTestRunner(ownerRoot) ?? null;
  // Package manager stays repo-rooted: the lockfile lives at the workspace root, not the
  // owning package.
  const pm = detectPackageManager(cwd);
  reportRunContext(reporter, {
    pm,
    typescript,
    runner,
    model: config.model,
    effort: config.effort,
    availableCount: available.length,
    all: opts.all,
    paths,
    scope,
    baselineTargets,
  });
  // Self-heal: clear any tend worktrees a crashed/cancelled prior run left registered before
  // this run adds its own.
  await pruneStaleWorktrees(snapshot.repoRoot());
  const sandboxPool = new WorkerSandboxPool({
    mainRoot: snapshot.repoRoot(),
    snapshotSha: snapshot.commitSha(),
    maxSandboxes: config.maxSessions,
    packageManager: pm,
  });
  // Run-wide cancellation: aborted on Ctrl-C / SIGTERM so pending work units are skipped and
  // in-flight `claude` subprocesses are killed instead of draining the whole backlog first.
  const abort = new AbortController();
  const { fixUnit, deterministicFixUnit, finalIntegration } = await makeProductionFixUnit(
    config,
    baselineTargets,
    ownerRoot,
    bus,
    { typescript, runner },
    sandboxPool,
    abort.signal,
  );
  // Whole-file deletion is the one fix that can destroy in-progress work, so never auto-delete a
  // file that's part of uncommitted changes (untracked or modified) — or a committed module that
  // such a file imports (its WIP cluster). Only committed, clean, genuinely-dead files are deleted;
  // everything else is reported. Mirrors knip's own opt-in file removal + the clean-tree codemod norm.
  const uncommitted = await changedVsHead(git);
  const likelyWipFiles = expandWipFilesByImports(uncommitted, cwd);
  if (uncommitted.length > 0) {
    reporter.note(
      `${plural(uncommitted.length, "uncommitted file")} present · unused-file deletion skips work in progress (tend is most reliable on a clean tree)`,
    );
  }

  // On Ctrl-C / SIGTERM, stop starting new work (abort + cancel), then tear down sandboxes
  // (remove worktrees) before exiting so a cancelled run leaves the repo exactly as a clean
  // completion would. dispose() is memoized, so this and the finally path below await the
  // same teardown — neither races process.exit ahead of removal.
  const stopSignals = onTerminationSignals((signal) => {
    abort.abort();
    sandboxPool.cancel();
    // Kill the eslint worker too: its open IPC channel would otherwise keep this process alive.
    disposeEslintWorker();
    // Fire-and-forget by design: the handler must return immediately; the process exits
    // once teardown settles, whether it succeeded or failed.
    const exit = () => process.exit(signal === "SIGINT" ? 130 : 143);
    sandboxPool.dispose().then(exit, exit);
  });

  // The live view draws concurrently with the orchestration; both share this event loop.
  const start = Date.now();
  const drawing = reporter.run();
  let result;
  let finalIntegrationResult: FinalIntegrationResult | undefined;
  try {
    result = await orchestrate({
      cwd,
      audit: buildAudit({
        cwd,
        which: realWhich,
        spawn: realSpawn,
        scope,
        timeoutMs: 120_000,
        bus,
        tracer,
        tracePhase: "audit",
      }),
      fixUnit,
      deterministicFixUnit: traceDeterministicUnit(deterministicFixUnit, bus),
      // A knip `unused-file` hit on a currently-broken (WIP) file is reported, not auto-deleted.
      config: { ...config, likelyWipFiles },
      inScope: scope ? (fs) => filterToChanged(fs, scope) : undefined,
      signal: abort.signal,
      bus,
    });
    finalIntegrationResult = await finalIntegration();
    if (!finalIntegrationResult.ok)
      rollbackFailedIntegration(finalIntegrationResult, sandboxPool, result, bus);
  } finally {
    stopSignals();
    disposeEslintWorker(); // close the worker's IPC channel so the process can exit
    await sandboxPool.dispose();
    reporter.close(); // unblock the view if orchestration threw before emitting `done`
  }
  await drawing;
  const durationMs = Date.now() - start;

  const builder = new ReportBuilder();
  builder.recordOutcomes(result.findings);
  builder.recordScannerStatuses(result.scannerStatuses);
  const report = builder.build({
    loops: result.loops,
    termination: result.termination,
    durationMs,
    exitStatus: result.exitStatus,
    aiUsage: result.usage,
    runScope: result.runScope,
    fixPolicy: {
      includeTests: Boolean(config.includeTests),
      include: config.fix.include,
      exclude: config.fix.exclude,
      includeGenerated: config.fix.includeGenerated,
      includeFixtures: config.fix.includeFixtures,
    },
    finalIntegration: finalIntegrationResult && toReportFinalIntegration(finalIntegrationResult),
  });
  persist(REPORT_PATH, report);
  archiveReport(report);

  out("");
  out(
    renderSummary(report, {
      theme,
      verbose: opts.verbose,
      plain: Boolean(opts.plain) || !env.interactive,
    }),
  );
  process.exitCode = result.exitStatus;
}

async function runRetry(id: string): Promise<void> {
  await assertGitRepo(createGit(process.cwd()));
  await rebaseToRepoRoot();
  const git = createGit(cwd);

  const report = loadReport();
  const target = resolveRetryTarget(id, report.findings);
  if ("error" in target) {
    err(`✖ ${target.error}`);
    process.exitCode = 1;
    return;
  }

  // Same restore-point guard as `run`: retry also captures+overwrites the snapshot (below), so
  // refuse upfront if a prior run's uncommitted edits would be stranded.
  if (!(await snapshotOverwriteAllowed(git))) {
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig(cwd);
  let snapshotSaved = false;
  let retrySandboxPool: WorkerSandboxPool | undefined;

  const result = await retryCommand(id, {
    report,
    baseBudget: config.perIssueBudget,
    runFix: async (finding) => {
      const plan = planRepair({
        finding,
        cwd,
        scope: finding,
        config: { ...config.fix, includeTests: config.includeTests },
      });
      const unit = planWorkFromRepairs([plan])[0];
      if (!unit) return { kept: false, reason: "session-error" };
      if (!snapshotSaved) {
        const snapshot = await Snapshot.capture(git, cwd);
        persist(SNAPSHOT_PATH, snapshot.toJSON());
        retrySandboxPool = new WorkerSandboxPool({
          mainRoot: snapshot.repoRoot(),
          snapshotSha: snapshot.commitSha(),
          maxSandboxes: config.maxSessions,
          packageManager: detectPackageManager(cwd),
        });
        snapshotSaved = true;
      }
      // Gate the retry against the package that owns the target's files, same as `run`.
      const ownerRoot = resolveOwnerRoot(cwd, unit.files);
      const { fixUnit } = await makeProductionFixUnit(
        config,
        unit.files,
        ownerRoot,
        undefined,
        undefined,
        retrySandboxPool,
      );
      return fixUnit(unit, 1);
    },
  }).finally(async () => {
    disposeEslintWorker();
    await retrySandboxPool?.dispose();
  });

  if ("error" in result) {
    err(`✖ ${result.error}`);
    process.exitCode = 1;
    return;
  }

  persist(REPORT_PATH, report);
  archiveReport(report);

  if (result.outcome === "fixed") {
    out(`✔ fixed ${result.finding.file} (retry budget ${result.budget})`);
    process.exitCode = 0;
    return;
  }

  out(
    `↩ reverted ${result.finding.file} — ${reasonLabel(result.reason)} (retry budget ${result.budget})`,
  );
  process.exitCode = 1;
}

const program = buildProgram({
  run: (opts) => runRun(opts),
  diff: async () => {
    await rebaseToRepoRoot();
    const snapshot = Snapshot.fromJSON(loadJson(SNAPSHOT_PATH));
    const changed = await snapshot.changedSince(createGit(cwd));
    out(changed.length ? changed.join("\n") : "No tool edits.");
  },
  undo: async () => {
    await rebaseToRepoRoot();
    const snapshot = Snapshot.fromJSON(loadJson(SNAPSHOT_PATH));
    await snapshot.restore(createGit(cwd));
    out("✔ Restored pre-run snapshot.");
  },
  show: async (id) => {
    await rebaseToRepoRoot();
    const report = loadReport();
    out(showCommand(id, report.findings));
  },
  retry: (id) => runRetry(id),
});

program.parseAsync(process.argv).catch((e: unknown) => {
  // commander throws for --help/--version (exitCode 0) and usage errors; honor its code
  if (e instanceof Error && e.name === "CommanderError") {
    process.exitCode = (e as Error & { exitCode?: number }).exitCode ?? 1;
    return;
  }
  err(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
