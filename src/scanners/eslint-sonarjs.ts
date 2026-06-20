import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execaNode } from "execa";
import { ESLint, type Linter } from "eslint";
import sonarjs from "eslint-plugin-sonarjs";
import type { Finding } from "../findings/finding.js";
import { normalize, type RawFinding } from "../findings/normalize.js";
import {
  defaultEslintConfigPath,
  defaultEslintTypedConfigPath,
  eslintMode,
  findEslintConfigDir,
  findTsconfigDir,
  projectConfiguresSonarjs,
  type EslintMode,
} from "./eslint-default-config.js";
import { toRepoRelative } from "./paths.js";
import type { ScanContext, ScanResult, Scanner, SpawnResult } from "./scanner.js";

type EslintMessage = {
  ruleId: string | null;
  severity: number;
  message: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  fix?: unknown;
};
type EslintResult = { filePath: string; messages: EslintMessage[] };

/** Map ESLint results (CLI JSON or Node-API LintResult[]) into tend's RawFindings. */
function mapEslintResults(results: EslintResult[], ctx: ScanContext): RawFinding[] {
  const findings: RawFinding[] = [];
  for (const result of results) {
    const file = toRepoRelative(ctx.cwd, result.filePath);
    for (const msg of result.messages) {
      if (msg.ruleId === null) continue; // fatal/parse errors aren't fixable findings
      findings.push({
        tool: "sonarjs",
        rule: msg.ruleId,
        category: "smell",
        severity: msg.severity === 2 ? "error" : "warning",
        file,
        range: {
          startLine: msg.line,
          startCol: msg.column,
          endLine: msg.endLine ?? msg.line,
          endCol: msg.endColumn ?? msg.column,
        },
        message: msg.message,
        autofixable: msg.fix !== undefined,
      });
    }
  }
  return findings;
}

/** Kept as a Scanner so the frozen-fixture parse path (CLI JSON) stays covered. */
export const eslintSonarjsScanner: Scanner = {
  tool: "sonarjs",
  binary: "eslint",
  buildArgs: (ctx) => ["--format", "json", ...ctx.files],
  parse: (raw: SpawnResult, ctx: ScanContext) => mapEslintResults(JSON.parse(raw.stdout) as EslintResult[], ctx),
};

/** A set of lint targets that share one resolved eslint config. */
type LintGroup = {
  /** Directory whose eslint config governs these files, or null for "no project config". */
  configDir: string | null;
  mode: EslintMode;
  /** cwd to run ESLint under — the config's directory (so its config is discovered). */
  cwd: string;
  /** Targets to lint, relative to `cwd`. */
  targets: string[];
  /**
   * Run with TypeScript type information (typescript-eslint project service), which activates
   * sonarjs's `requiresTypeChecking` rules. True when a tsconfig.json governs at least one
   * target; files the project service can't cover are rescued syntactically (see lintGroup).
   */
  typed: boolean;
};

function relativeLintTarget(from: string, to: string): string {
  return relative(from, to) || ".";
}

/** Kill switch for type-aware linting (e.g. repos where program construction is too heavy). */
function typedLintEnabled(): boolean {
  const flag = process.env["TEND_ESLINT_TYPED"];
  return flag !== "0" && flag !== "off" && flag !== "false";
}

/** Should this group lint with type information? Any target governed by a tsconfig qualifies. */
function groupIsTyped(mode: EslintMode, absFiles: string[], boundary: string): boolean {
  if (mode === "defer" || !typedLintEnabled()) return false;
  return absFiles.some((f) => findTsconfigDir(dirname(f), boundary) !== null);
}

/**
 * Group scoped files by their governing eslint config. Each file's config is resolved by walking
 * up from the file's directory (bounded by ctx.cwd) — NOT from ctx.cwd alone — so files in a
 * monorepo package use that package's config even when tend runs from the repo root.
 */
function groupByConfig(ctx: ScanContext): LintGroup[] {
  const boundary = resolve(ctx.cwd);
  const byDir = new Map<string, string[]>(); // key: configDir, or "" for the no-config bucket
  for (const file of ctx.files) {
    const abs = resolve(ctx.cwd, file);
    const configDir = findEslintConfigDir(dirname(abs), boundary);
    const key = configDir ?? "";
    (byDir.get(key) ?? byDir.set(key, []).get(key)!).push(abs);
  }

  return [...byDir.entries()].map(([key, absFiles]): LintGroup => {
    if (key === "") {
      // No project config anywhere up to ctx.cwd → tend's bundled default, rooted at ctx.cwd.
      return {
        configDir: null,
        mode: "default",
        cwd: ctx.cwd,
        targets: absFiles.map((f) => relativeLintTarget(ctx.cwd, f)),
        typed: groupIsTyped("default", absFiles, boundary),
      };
    }
    const mode = projectConfiguresSonarjs(key) ? "defer" : "layer";
    return {
      configDir: key,
      mode,
      cwd: key,
      targets: absFiles.map((f) => relativeLintTarget(key, f)),
      typed: groupIsTyped(mode, absFiles, boundary),
    };
  });
}

// Layered onto the project's config in typed layer mode. Activates parser services for TS
// files when the project's parser is typescript-eslint's; other parsers ignore the option,
// and files outside every tsconfig fail with a fatal message that the rescue pass handles.
const TYPED_PARSER_LAYER: Linter.Config = {
  files: ["**/*.{ts,mts,cts,tsx}"],
  languageOptions: { parserOptions: { projectService: true } },
};

/** Lint one group through the Node API; ESLint returns absolute filePaths regardless of cwd. */
function eslintOptionsForGroup(group: LintGroup, typed: boolean = group.typed): ESLint.Options {
  const options: ESLint.Options = { cwd: group.cwd, errorOnUnmatchedPattern: false };
  if (group.mode === "default") {
    options.overrideConfigFile = typed ? defaultEslintTypedConfigPath() : defaultEslintConfigPath();
  } else if (group.mode === "layer") {
    // Append sonarjs ON TOP of the project's discovered config (the CLI `--config` flag can't —
    // it replaces). `defer` adds nothing: the project already configures sonarjs itself.
    options.overrideConfig = typed
      ? [sonarjs.configs.recommended, TYPED_PARSER_LAYER]
      : [sonarjs.configs.recommended];
  }
  return options;
}

/**
 * A fatal message produced when type-aware parsing rejects a file the TS project service
 * cannot cover (not included in any tsconfig, conflicting parserOptions.project, broken
 * tsconfig, …). Such files are re-linted syntactically so they keep today's coverage.
 */
function isTypedParseFailure(msg: EslintMessage): boolean {
  return msg.ruleId === null && /project service|projectService|parserOptions\.project|allowDefaultProject/i.test(msg.message);
}

async function lintGroup(group: LintGroup): Promise<EslintResult[]> {
  if (!group.typed) {
    const eslint = new ESLint(eslintOptionsForGroup(group));
    return (await eslint.lintFiles(group.targets)) as EslintResult[];
  }

  let results: EslintResult[];
  try {
    const eslint = new ESLint(eslintOptionsForGroup(group, true));
    results = (await eslint.lintFiles(group.targets)) as EslintResult[];
  } catch {
    // Type-aware run failed outright (e.g. unparseable tsconfig) → whole group falls back.
    const eslint = new ESLint(eslintOptionsForGroup(group, false));
    return (await eslint.lintFiles(group.targets)) as EslintResult[];
  }

  // Per-file rescue: anything the project service couldn't parse re-lints syntactically, so
  // typed mode strictly adds findings and never costs a file the coverage it has today.
  const failed = results.filter((r) => r.messages.some(isTypedParseFailure));
  if (failed.length === 0) return results;
  const failedPaths = new Set(failed.map((r) => r.filePath));
  const eslint = new ESLint(eslintOptionsForGroup(group, false));
  const rescued = (await eslint.lintFiles([...failedPaths])) as EslintResult[];
  return [...results.filter((r) => !failedPaths.has(r.filePath)), ...rescued];
}

function messageMatchesFinding(message: Linter.LintMessage, finding: Finding): boolean {
  return message.ruleId === finding.rule && message.line === finding.range.startLine;
}

async function fixGroup(group: LintGroup, findings: Finding[]): Promise<EslintResult[]> {
  const options: ESLint.Options = {
    ...eslintOptionsForGroup(group),
    fix: (message) => findings.some((finding) => messageMatchesFinding(message, finding)),
    fixTypes: ["problem", "suggestion", "layout"],
  };
  const eslint = new ESLint(options);
  return (await eslint.lintFiles(group.targets)) as EslintResult[];
}

type EslintFixResult = { changed: boolean; error?: string };

/**
 * Apply ESLint's own autofixes for the exact findings Tend has assigned to the current unit.
 * Each file is linted separately so the fix predicate's rule/line match is scoped to that file.
 */
export async function applyEslintFixesForFindings(ctx: ScanContext, findings: Finding[]): Promise<EslintFixResult> {
  const files = [...new Set(findings.map((finding) => finding.file))];
  if (files.length === 0) return { changed: false };

  try {
    const results: EslintResult[] = [];
    for (const file of files) {
      const fileFindings = findings.filter((finding) => finding.file === file);
      for (const group of groupByConfig({ ...ctx, files: [file] })) {
        results.push(...(await fixGroup(group, fileFindings)));
      }
    }
    await ESLint.outputFixes(results as Awaited<ReturnType<ESLint["lintFiles"]>>);
    return { changed: results.some((result) => "output" in result) };
  } catch (err) {
    return { changed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Run eslint+sonarjs via the Node API (eslint is bundled), IN THIS PROCESS. Resolves the
 * applicable config PER FILE and runs one pass per config group, so monorepo packages are linted
 * under their own config. Three modes per group:
 *  default → tend's config · layer → project config + sonarjs · defer → project config.
 * Output paths stay relative to the original ctx.cwd so finding IDs/filtering are unaffected.
 *
 * Type-aware linting (`projectService`) builds the project's entire TypeScript program in-heap —
 * easily >1 GB on a large app — so the default entry point is {@link runEslintSonarjs}, which runs
 * THIS function in a short-lived child process whose memory is reclaimed on exit. This in-process
 * form is used by that child, by the autofix path, and as a dev/test fallback.
 */
export async function runEslintSonarjsInProcess(ctx: ScanContext): Promise<ScanResult> {
  // Whole-repo scan: one pass rooted at ctx.cwd, mode decided there.
  const wholeRepoMode = eslintMode(ctx.cwd);
  const groups: LintGroup[] =
    ctx.files.length === 0 || ctx.files.includes(".")
      ? [
          {
            configDir: null,
            mode: wholeRepoMode,
            cwd: ctx.cwd,
            targets: ["."],
            // Decided by a root-level tsconfig only (no tree walk on a whole-repo scan).
            // Once typed, the project service still matches each file to its NEAREST
            // tsconfig, so per-package tsconfigs under a root one are honored.
            typed: groupIsTyped(wholeRepoMode, [resolve(ctx.cwd, "tsconfig.json")], ctx.cwd),
          },
        ]
      : groupByConfig(ctx);

  try {
    const results: EslintResult[] = [];
    for (const group of groups) {
      results.push(...(await lintGroup(group)));
    }
    const findings = mapEslintResults(results, ctx).map((r) => normalize(r, ctx.loop));
    return { tool: "sonarjs", findings, skipped: false };
  } catch (err) {
    return { tool: "sonarjs", findings: [], skipped: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Child-process heap (MB) for the eslint worker; generous because it builds the whole TS program. */
const ESLINT_WORKER_HEAP_MB = Number(process.env["TEND_ESLINT_WORKER_HEAP_MB"]) || 8192;

/**
 * The built worker entry that runs {@link runEslintSonarjsInProcess}, or null when unavailable
 * (running from source / tests). The candidates cover wherever the bundler places this module
 * relative to the worker: tsdown emits `dist/scanners/eslint-worker.js` while the caller may be
 * inlined into `dist/bin.js` or a sibling chunk.
 */
function eslintWorkerPath(): string | null {
  const candidates = [
    "./eslint-worker.js", // caller bundled alongside the worker (dist/scanners/)
    "./scanners/eslint-worker.js", // caller at dist root (bin.js / a chunk)
    "../scanners/eslint-worker.js",
  ];
  for (const rel of candidates) {
    try {
      const path = fileURLToPath(new URL(rel, import.meta.url));
      if (existsSync(path)) return path;
    } catch {
      /* malformed URL on this candidate — try the next */
    }
  }
  return null;
}

type ScanRequest = { id: number; ctx: ScanContext };
export type WorkerReply = { id: number; result?: ScanResult; error?: string };

function isReplyFor(message: unknown, id: number): boolean {
  return typeof message === "object" && message !== null && (message as WorkerReply).id === id;
}

/** The capability {@link runEslintSonarjs} needs from a worker — the seam tests inject a stub at. */
export interface EslintScanWorker {
  scan(ctx: ScanContext): Promise<ScanResult>;
}

/** The message channel the worker process serves over (real impl: execa getEachMessage/sendMessage). */
export interface EslintWorkerTransport {
  requests(): AsyncIterable<ScanRequest>;
  reply(message: WorkerReply): Promise<void>;
}

/**
 * The worker process's serve loop, lifted out of the entry shim so it's unit-testable IN-PROCESS:
 * for each scan request from the transport, run it and reply with the result, or reply with an
 * error if the scan throws. Returns when the request stream ends (the parent closed the channel).
 * `scan` is injectable so the error branch is testable; production uses {@link runEslintSonarjsInProcess}.
 */
export async function serveEslintScans(
  transport: EslintWorkerTransport,
  scan: (ctx: ScanContext) => Promise<ScanResult> = runEslintSonarjsInProcess,
): Promise<void> {
  for await (const { id, ctx } of transport.requests()) {
    try {
      const result = await scan(ctx);
      await transport.reply({ id, result });
    } catch (err) {
      await transport.reply({ id, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    }
  }
}

/**
 * A persistent Node worker (execa `execaNode`, IPC enabled) that runs the eslint+sonarjs scan out
 * of tend's process.
 *
 * Why persistent (not a child per scan): type-aware linting builds the project's whole TypeScript
 * program — millions of AST/Symbol objects, >1 GB on a large app. Run in tend's process on every
 * audit it stacks on the run's state and exhausts the ~4 GB heap → `JavaScript heap out of memory`,
 * killing the run after fixes already succeeded. A separate process isolates that memory (its own
 * heap via `nodeOptions: --max-old-space-size`, reclaimed on disposal) AND — by keeping ONE worker
 * alive across audits — lets typescript-eslint's `projectService` reuse its warm program instead of
 * rebuilding it cold every loop.
 *
 * execa (vs raw child_process.fork) handles the footguns: it kills the child if tend exits
 * (`cleanup`), escalates SIGTERM→SIGKILL on a stuck child, and gives typed IPC. An open IPC channel
 * still keeps the parent alive, so the worker is disposed explicitly (see {@link disposeEslintWorker},
 * wired into bin teardown). Scans are serialized (one warm program); if the child dies — including
 * its own OOM on a huge repo — the in-flight scan rejects (the caller degrades sonarjs for that loop
 * rather than crashing tend) and the next scan transparently respawns it.
 */
// Fork the worker with IPC + its own big heap. A factory (rather than an inline call) lets the
// subprocess type be derived precisely via ReturnType — with `ipc: true`, execa types sendMessage/
// getOneMessage as present (they're `undefined` on a non-IPC subprocess), so the calls type-check.
function spawnEslintChild(workerPath: string) {
  return execaNode(workerPath, [], {
    ipc: true,
    nodeOptions: [`--max-old-space-size=${ESLINT_WORKER_HEAP_MB}`],
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
}
type EslintChild = ReturnType<typeof spawnEslintChild>;

export class EslintWorker implements EslintScanWorker {
  private child: EslintChild | null = null;
  private nextId = 1;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly workerPath: string) {}

  private ensureChild(): EslintChild {
    // `connected` is the live IPC-channel state: false the moment the child exits/dies, so a dead
    // handle is replaced deterministically (no reliance on the exit callback having run yet).
    if (this.child?.connected) return this.child;
    const child = spawnEslintChild(this.workerPath);
    this.child = child;
    // Swallow execa's exit/kill rejection and drop the handle so the next scan respawns. A scan
    // awaiting a reply rejects independently via getOneMessage.
    const drop = (): void => {
      if (this.child === child) this.child = null;
    };
    void child.then(drop, drop);
    return child;
  }

  private async dispatch(ctx: ScanContext): Promise<ScanResult> {
    const child = this.ensureChild();
    const id = this.nextId++;
    await child.sendMessage({ id, ctx });
    const reply = (await child.getOneMessage({ filter: (m) => isReplyFor(m, id) })) as WorkerReply;
    if (reply.error) throw new Error(reply.error);
    return reply.result as ScanResult;
  }

  /** Run a scan, serialized after any in-flight scan (the worker holds one warm program). */
  scan(ctx: ScanContext): Promise<ScanResult> {
    // `tail` is kept always-resolved (the swallow below), so the next scan starts whether the
    // previous one resolved or rejected — no separate rejected handler needed here.
    const result = this.tail.then(() => this.dispatch(ctx));
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  dispose(): void {
    const child = this.child;
    this.child = null;
    child?.kill();
  }
}

let workerInstance: EslintWorker | null = null;

/** Lazily create the shared worker, or null when the built worker isn't available (source/tests). */
function eslintWorker(): EslintWorker | null {
  if (workerInstance) return workerInstance;
  const path = eslintWorkerPath();
  if (!path) return null;
  workerInstance = new EslintWorker(path);
  return workerInstance;
}

/**
 * Tear down the shared eslint worker (kill the child, close the IPC channel). MUST be called at
 * run teardown: an open fork IPC channel keeps the parent process alive, so without this tend would
 * hang after finishing. Wired into bin.ts's normal-completion and signal teardown paths. Idempotent.
 */
export function disposeEslintWorker(): void {
  workerInstance?.dispose();
  workerInstance = null;
}

/**
 * Run eslint+sonarjs out-of-process via the persistent {@link EslintWorker}.
 *
 * Falls back to in-process only when the built worker isn't present (running from source / tests)
 * or — for a request — the spawn/send itself fails before the child is up. A worker that runs but
 * dies (including its own OOM) is reported as a scanner failure for this loop and NOT retried
 * in-process, which would just re-OOM tend; the next scan respawns the worker.
 */
export async function runEslintSonarjs(
  ctx: ScanContext,
  // The worker to delegate to. Omitted in production (resolves the shared worker); tests pass a
  // stub to drive the success/degrade/fallback contract, or `null` to exercise the fallback.
  workerOverride?: EslintScanWorker | null,
): Promise<ScanResult> {
  if (process.env["TEND_ESLINT_INPROCESS"] === "1") return runEslintSonarjsInProcess(ctx);
  const worker = workerOverride === undefined ? eslintWorker() : workerOverride;
  if (!worker) return runEslintSonarjsInProcess(ctx);
  try {
    return await worker.scan(ctx);
  } catch (err) {
    return { tool: "sonarjs", findings: [], skipped: false, error: err instanceof Error ? err.message : String(err) };
  }
}
