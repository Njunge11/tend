#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { buildProgram } from "./cli.js";
import { buildAudit, scanFiles, scannerAvailability } from "./scanners/all.js";
import { realSpawn, realWhich } from "./scanners/exec.js";
import { filterToChanged } from "./scanners/scope.js";
import { changedVsHead, assertGitRepo } from "./git/repo.js";
import { createGit } from "./git/client.js";
import { Snapshot } from "./git/snapshot.js";
import { detectPackageManager } from "./detect/package-manager.js";
import { detectTestRunner } from "./detect/test-runner.js";
import { detectTypeScript } from "./detect/typescript.js";
import { makeFixUnit } from "./fixing/fix-unit.js";
import type { WorkUnit } from "./fixing/dispatch.js";
import { planWork } from "./fixing/dispatch.js";
import { ClaudeSession } from "./session/claude.js";
import { orchestrate } from "./orchestrator.js";
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
const TSC_TIMEOUT_MS = 5 * 60_000;
const TEST_TIMEOUT_MS = 5 * 60_000;
const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

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

/** Run the detected test runner over the given files and parse pass/fail per test. */
async function runTests(
  runner: "vitest" | "jest",
  files: string[],
): Promise<TestOutcome[]> {
  const args =
    runner === "vitest"
      ? ["vitest", "related", ...files, "--run", "--reporter=json"]
      : ["jest", "--findRelatedTests", ...files, "--json"];
  const res = await execa("npx", args, {
    cwd,
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
): Promise<{
  fixUnit: (
    unit: WorkUnit,
    loop: number,
  ) => Promise<{
    kept: boolean;
    reason?: import("./gate/check.js").RevertReason;
  }>;
  typescript: boolean;
  runner: "vitest" | "jest" | null;
}> {
  const typescript = detectTypeScript(cwd);
  const runner = detectTestRunner(cwd) ?? null;
  const baseline = new Set<string>(
    runner && baselineTargets.length > 0
      ? (await runTests(runner, baselineTargets))
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
      // On timeout/kill exitCode is undefined; treat any failure as non-zero so the session
      // is judged failed (and the change reverted) rather than silently accepted.
      const exitCode = r.exitCode ?? (r.failed ? 1 : 0);
      return { stdout: typeof r.stdout === "string" ? r.stdout : "", exitCode };
    },
  });

  return {
    typescript,
    runner,
    fixUnit: makeFixUnit({
      cwd,
      session,
      typescript,
      runTsc: async () => {
        const r = await execa("npx", ["tsc", "--noEmit"], {
          cwd,
          reject: false,
          timeout: TSC_TIMEOUT_MS,
        });
        // exitCode is undefined on timeout/spawn failure → treat as a typecheck failure (revert).
        return {
          exitCode: r.exitCode ?? 1,
          output: `${r.stdout}\n${r.stderr}`,
        };
      },
      hasTestRunner: Boolean(runner),
      runRelated: (files) =>
        runner ? runTests(runner, files) : Promise.resolve([]),
      scanFindings: async (files) =>
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
      maxRepairs: 3,
    }),
  };
}

async function runRun(opts: {
  all?: boolean;
  maxLoops?: number;
  maxSessions?: number;
  model?: string;
  effort?: string;
  includeTests?: boolean;
  plain?: boolean;
  color?: boolean;
  verbose?: boolean;
}): Promise<void> {
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

  // Capture the pristine test baseline (which tests are green before any fix), scoped to the
  // files we'll touch. Relating against "." runs the whole suite and can take many minutes.
  const changed = opts.all ? null : await changedVsHead(git);
  const baselineTargets = changed ?? ["."];
  const { fixUnit, runner, typescript } = await makeProductionFixUnit(
    config,
    baselineTargets,
  );
  const pm = detectPackageManager(cwd);
  reporter.note(
    `${pm} · ${typescript ? "TypeScript" : "JavaScript"} · ${runner ?? "no test runner"} · ${modelLabel}`,
  );

  const scope = opts.all
    ? "whole repo"
    : `${plural(changed?.length ?? 0, "changed file")}`;
  reporter.note(`${scope} · ${plural(available.length, "scanner")}`);

  const bus = new EventBus();
  bus.on((e) => reporter.onEvent(e));

  // The live view draws concurrently with the orchestration; both share this event loop.
  const start = Date.now();
  const drawing = reporter.run();
  let result;
  try {
    result = await orchestrate({
      audit: buildAudit({
        cwd,
        git,
        which: realWhich,
        spawn: realSpawn,
        all: Boolean(opts.all),
        timeoutMs: 120_000,
      }),
      fixUnit,
      config,
      inScope: changed ? (fs) => filterToChanged(fs, changed) : undefined,
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
      const unit = planWork([finding])[0];
      if (!unit) return { kept: false, reason: "session-error" };
      if (!snapshotSaved) {
        const snapshot = await Snapshot.capture(git, cwd);
        persist(SNAPSHOT_PATH, snapshot.toJSON());
        snapshotSaved = true;
      }
      const { fixUnit } = await makeProductionFixUnit(config, unit.files);
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

const argv =
  process.argv.slice(2).length === 0 ? [...process.argv, "run"] : process.argv;
program.parseAsync(argv).catch((e: unknown) => {
  // commander throws for --help/--version (exitCode 0) and usage errors; honor its code
  if (e instanceof Error && e.name === "CommanderError") {
    process.exitCode = (e as Error & { exitCode?: number }).exitCode ?? 1;
    return;
  }
  err(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
