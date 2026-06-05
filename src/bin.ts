#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { makeDeterministicFixUnit } from "./fixing/deterministic.js";
import { detectBuildCommand } from "./fixing/generated-source.js";
import type { WorkUnit } from "./fixing/dispatch.js";
import { planWorkFromRepairs } from "./fixing/dispatch.js";
import { planRepair } from "./fixing/repair-strategy.js";
import { ClaudeSession } from "./session/claude.js";
import { orchestrate } from "./orchestrator.js";
import type { FixOutcome } from "./orchestrator.js";
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

const cwd = process.cwd();
const TEND_DIR = join(cwd, ".tend");
const SNAPSHOT_PATH = join(TEND_DIR, "snapshot.json");
const REPORT_PATH = join(TEND_DIR, "report.json");

// Upper bounds so a hung child can't stall the run forever — execa kills it on timeout.
const CLAUDE_TIMEOUT_MS = 10 * 60_000; // one file-fix session
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

/**
 * Run the detected test runner over the given files and parse pass/fail per test.
 * `files` are repo-relative; `root` is the package that owns them (the cwd the runner
 * executes in). Files are re-based onto `root` so `vitest related` / `jest
 * --findRelatedTests` resolve them inside the owning package, not the repo root.
 */
async function runTests(
  runner: "vitest" | "jest",
  files: string[],
  root: string,
): Promise<TestOutcome[]> {
  const targets = toOwnerRelative(files, cwd, root);
  const args =
    runner === "vitest"
      ? ["vitest", "related", ...targets, "--run", "--reporter=json"]
      : ["jest", "--findRelatedTests", ...targets, "--json"];
  const res = await execa("npx", args, {
    cwd: root,
    reject: false,
    timeout: TEST_TIMEOUT_MS,
  });
  try {
    const json = JSON.parse(res.stdout) as {
      testResults?: {
        assertionResults?: {
          fullName?: string;
          title?: string;
          status: string;
        }[];
      }[];
    };
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
  } catch {
    return [];
  }
}

async function makeProductionFixUnit(
  config: { model: string; effort?: Effort },
  baselineTargets: string[],
  // The package root that owns the scoped files. Detection (TypeScript/test runner),
  // the test baseline, typecheck, and related-test runs all execute here so a
  // path-scoped run inside a monorepo gates against the owning package, not the repo
  // root. Defaults to the repo cwd for whole-repo / root-package runs.
  ownerRoot: string = cwd,
  bus?: EventBus,
  detected?: { typescript: boolean; runner: "vitest" | "jest" | null },
): Promise<{
  fixUnit: (unit: WorkUnit, loop: number) => Promise<FixOutcome>;
  deterministicFixUnit: (unit: WorkUnit, loop: number) => Promise<FixOutcome>;
  typescript: boolean;
  runner: "vitest" | "jest" | null;
}> {
  const typescript = detected?.typescript ?? detectTypeScript(ownerRoot);
  const runner = detected?.runner ?? detectTestRunner(ownerRoot) ?? null;
  const buildArgs = detectBuildCommand(ownerRoot);
  const pm = detectPackageManager(ownerRoot);
  const baseline = new Set<string>(
    runner && baselineTargets.length > 0
      ? (await runTests(runner, baselineTargets, ownerRoot))
          .filter((t) => t.status === "pass")
          .map((t) => t.name)
      : [],
  );
  const session = new ClaudeSession({
    spawn: async (req) => {
      const r = await execa(
        "claude",
        [
          "-p",
          req.prompt,
          "--model",
          config.model,
          ...(config.effort ? ["--effort", config.effort] : []),
          "--output-format",
          "stream-json",
          "--verbose",
          "--allowedTools",
          "Read,Write,Edit",
        ],
        { cwd, reject: false, timeout: CLAUDE_TIMEOUT_MS },
      );
      // On timeout/kill exitCode is often undefined; preserve that as the conventional
      // SIGTERM exit so session classification can treat it as a tool timeout.
      const exitCode = r.exitCode ?? (r.timedOut ? 143 : r.failed ? 1 : 0);
      return { stdout: typeof r.stdout === "string" ? r.stdout : "", exitCode };
    },
  });

  const gateDeps = {
    cwd,
    typescript,
    runTsc: async () => {
      const r = await execa("npx", ["tsc", "--noEmit"], {
        // tsc picks up the owning package's tsconfig from its cwd.
        cwd: ownerRoot,
        reject: false,
        timeout: TSC_TIMEOUT_MS,
      });
      // exitCode is undefined on timeout/spawn failure → treat as a typecheck failure (revert).
      return {
        exitCode: r.exitCode ?? 1,
        output: `${r.stdout}\n${r.stderr}`,
      };
    },
    runBuild: buildArgs
      ? async () => {
          const r = await execa(pm, buildArgs, {
            cwd: ownerRoot,
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
      runner ? runTests(runner, files, ownerRoot) : Promise.resolve([]),
    scanFindings: async (files: string[]) =>
      (
        await scanFiles(
          {
            cwd,
            which: realWhich,
            spawn: realSpawn,
            timeoutMs: 120_000,
          },
          files,
          0,
        )
      ).findings,
    baseline,
  };

  return {
    typescript,
    runner,
    fixUnit: makeFixUnit({
      ...gateDeps,
      session,
      maxRepairs: 3,
      onProgress: (event) => bus?.emit({ type: "file-stage", ...event }),
    }),
    deterministicFixUnit: makeDeterministicFixUnit(gateDeps),
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

  // Resolve the fix scope once and feed it to everything downstream (test baseline, audit,
  // fix filter). `null` means the whole repo (`--all`); otherwise it's the concrete file list
  // to fix — explicit path arguments expanded to files, or the files changed vs HEAD.
  const paths = opts.paths ?? [];
  let scope: string[] | null;
  if (opts.all) {
    scope = null;
  } else if (paths.length > 0) {
    scope = await filesUnder(git, paths);
    if (scope.length === 0) {
      err(`✖ no files under ${paths.join(", ")}`);
      process.exitCode = 1;
      return;
    }
  } else {
    scope = await changedVsHead(git);
  }

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
  const { fixUnit, deterministicFixUnit } = await makeProductionFixUnit(
    config,
    baselineTargets,
    ownerRoot,
    bus,
    { typescript, runner },
  );

  // The live view draws concurrently with the orchestration; both share this event loop.
  const start = Date.now();
  const drawing = reporter.run();
  let result;
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
      bus,
    });
  } finally {
    reporter.close(); // unblock the view if orchestration threw before emitting `done`
  }
  await drawing;
  const durationMs = Date.now() - start;

  const builder = new ReportBuilder();
  builder.recordOutcomes(result.findings);
  builder.recordScannerStatuses(result.scannerStatuses);
  const report = builder.build({
    loops: result.loops,
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
        snapshotSaved = true;
      }
      // Gate the retry against the package that owns the target's files, same as `run`.
      const ownerRoot = resolveOwnerRoot(cwd, unit.files);
      const { fixUnit } = await makeProductionFixUnit(
        config,
        unit.files,
        ownerRoot,
      );
      return fixUnit(unit, 1);
    },
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
