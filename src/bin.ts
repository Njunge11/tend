#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { buildProgram, type CliHandlers } from "./cli.js";
import { buildAudit, scanFiles, scannerAvailability } from "./scanners/all.js";
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
import { makeDeterministicFixUnit } from "./fixing/deterministic.js";
import { detectBuildCommand } from "./fixing/generated-source.js";
import { planWorkFromRepairs, type WorkUnit } from "./fixing/dispatch.js";
import type { Finding, Tool } from "./findings/finding.js";
import { planRepair } from "./fixing/repair-strategy.js";
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
import { orchestrate, type FixOutcome } from "./orchestrator.js";
import { ReportBuilder } from "./report/builder.js";
import { ReportSchema, type Report } from "./report/schema.js";
import { renderSummary } from "./output/summary.js";
import { EventBus } from "./output/events.js";
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

function effortForFindings(findings: Pick<Finding, "category" | "autofixable">[]): Effort {
  if (findings.length === 0) return "medium";
  const allMechanical = findings.every(
    (f) => f.category === "dead-code" || f.autofixable === true,
  );
  return allMechanical ? "low" : "medium";
}

const cwd = process.cwd();
const TEND_DIR = join(cwd, ".tend");
const SNAPSHOT_PATH = join(TEND_DIR, "snapshot.json");
const REPORT_PATH = join(TEND_DIR, "report.json");
// tend-owned, outside any sandbox worktree → the tsc build-info survives worktree
// reset/clean and is reused across iterations (Fix 5).
const TEND_CACHE_DIR = join(TEND_DIR, "cache");

// Upper bounds so a hung child can't stall the run forever — execa kills it on timeout.
// One cap for a single AI fix session. Used both to kill the `claude -p` subprocess and as the
// fix-unit session-timeout wrapper (passed below), so the enforced limit always matches the intent.
const CLAUDE_TIMEOUT_MS = Number(process.env.TEND_SESSION_TIMEOUT_MS) || 10 * 60_000;
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

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function loadReport(): Report {
  if (!existsSync(REPORT_PATH))
    throw new Error("No .tend/report.json found. Run `tend run` first.");
  return ReportSchema.parse(loadJson<unknown>(REPORT_PATH));
}

// Unique JSON-report path per runTests invocation; concurrent gates never collide.
let testReportSeq = 0;

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
    const outcomes: TestOutcome[] = [];
    for (const file of json.testResults ?? []) {
      for (const a of file.assertionResults ?? []) {
        outcomes.push({
          name: a.fullName ?? a.title ?? "",
          status: a.status === "passed" ? "pass" : "fail",
        });
      }
    }
    return outcomes;
  } finally {
    rmSync(reportFile, { force: true });
  }
}

type TestRunner = "vitest" | "jest" | null;

type FinalIntegrationResult =
  | { ok: true; files: string[] }
  | { ok: false; files: string[]; detail: string };

/** The slice of the gate deps the final-integration checks consume. */
type FinalIntegrationGate = {
  runTsc: () => Promise<{ exitCode: number; output: string }>;
  runRelated: (files: string[]) => Promise<TestOutcome[]>;
  scanFindings: (files: string[], tools?: Tool[]) => Promise<unknown[]>;
};

/** Failure detail when the final whole-run typecheck fails; undefined when clean or skipped. */
async function finalTypecheckFailure(
  gate: FinalIntegrationGate,
  typescript: boolean,
): Promise<string | undefined> {
  if (!typescript) return undefined;
  const tc = await gate.runTsc();
  if (tc.exitCode === 0) return undefined;
  return `final integration typecheck failed: ${tc.output}`;
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

/** Failure detail when the final scanner rescan still finds issues; undefined when clean or skipped. */
async function finalRescanFailure(
  gate: FinalIntegrationGate,
  tools: Tool[],
  files: string[],
): Promise<string | undefined> {
  if (tools.length === 0) return undefined;
  const findings = await gate.scanFindings(files, tools);
  if (findings.length === 0) return undefined;
  return `final integration scanner rescan found ${findings.length} finding${findings.length === 1 ? "" : "s"}`;
}

async function makeProductionFixUnit(
  config: { model: string; effort?: Effort; thinkingBudget?: number },
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
  const makeGateDeps = (sandbox?: WorkerSandbox) => {
    const repoRoot = sandbox?.cwd ?? cwd;
    const gateOwnerRoot = sandbox ? mapOwnerRoot(cwd, ownerRoot, sandbox.cwd) : ownerRoot;
    const session = new ClaudeSession({
      spawn: async (req) => {
        const unitEffort = config.effort ?? effortForFindings(req.findings);
        const child = execa(
          "claude",
          [
            ...(process.env.ANTHROPIC_API_KEY ? ["--bare"] : []),
            "--no-session-persistence",
            "-p",
            req.prompt,
            "--model",
            modelForUnit(req.findings, config),
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
        return { stdout: typeof r.stdout === "string" ? r.stdout : "", exitCode: r.exitCode ?? fallbackExit };
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
          cacheFile: tscCacheFile(TEND_CACHE_DIR, cwd, ownerRoot),
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
            },
            files,
            0,
          )
        ).findings,
      baseline,
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

  return {
    typescript,
    runner,
    fixUnit,
    deterministicFixUnit: makeDeterministicFixUnit(mainGateDeps),
    finalIntegration: async () => {
      const files = [...acceptedFiles].sort();
      if (files.length === 0) return { ok: true, files };
      // Checks run in order and short-circuit: tests only run after a clean typecheck, the
      // rescan only after green tests — same sequencing as the per-unit gate.
      const detail =
        (await finalTypecheckFailure(mainGateDeps, typescript)) ??
        (await finalTestFailure(mainGateDeps, runner, files)) ??
        (await finalRescanFailure(mainGateDeps, [...acceptedTools], files));
      return detail === undefined ? { ok: true, files } : { ok: false, files, detail };
    },
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

  const git = createGit(cwd);
  await assertGitRepo(git);

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

  const snapshot = await Snapshot.capture(git, cwd);
  persist(SNAPSHOT_PATH, snapshot.toJSON());
  reporter.note("snapshot saved · undo: tend undo");

  const modelLabel = config.effort
    ? `${config.model} (effort ${config.effort})`
    : config.model;

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
  reporter.note(
    `${pm} · ${typescript ? "TypeScript" : "JavaScript"} · ${runner ?? "no test runner"} · ${modelLabel}`,
  );

  const scopeNote = describeScopeNote(opts.all, paths, scope);
  reporter.note(`${scopeNote} · ${plural(available.length, "scanner")}`);
  if (runner && baselineTargets.length > 0) {
    reporter.note(
      `baseline: ${runner} related ${describeScopeNote(opts.all, paths, scope)} (one-time)`,
    );
  }
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

  // On Ctrl-C / SIGTERM, stop starting new work (abort + cancel), then tear down sandboxes
  // (remove worktrees) before exiting so a cancelled run leaves the repo exactly as a clean
  // completion would. dispose() is memoized, so this and the finally path below await the
  // same teardown — neither races process.exit ahead of removal.
  const stopSignals = onTerminationSignals((signal) => {
    abort.abort();
    sandboxPool.cancel();
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
      }),
      fixUnit,
      deterministicFixUnit,
      config,
      inScope: scope ? (fs) => filterToChanged(fs, scope) : undefined,
      signal: abort.signal,
      bus,
    });
    finalIntegrationResult = await finalIntegration();
    if (!finalIntegrationResult.ok) result.exitStatus = 1;
  } finally {
    stopSignals();
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
    finalIntegration: finalIntegrationResult,
  });
  persist(REPORT_PATH, report);

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
  const git = createGit(cwd);
  await assertGitRepo(git);

  const report = loadReport();
  const target = resolveRetryTarget(id, report.findings);
  if ("error" in target) {
    err(`✖ ${target.error}`);
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
    await retrySandboxPool?.dispose();
  });

  if ("error" in result) {
    err(`✖ ${result.error}`);
    process.exitCode = 1;
    return;
  }

  persist(REPORT_PATH, report);

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
    const snapshot = Snapshot.fromJSON(loadJson(SNAPSHOT_PATH));
    const changed = await snapshot.changedSince(createGit(cwd));
    out(changed.length ? changed.join("\n") : "No tool edits.");
  },
  undo: async () => {
    const snapshot = Snapshot.fromJSON(loadJson(SNAPSHOT_PATH));
    await snapshot.restore(createGit(cwd));
    out("✔ Restored pre-run snapshot.");
  },
  show: (id) => {
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
