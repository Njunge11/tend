import { dirname, relative, resolve } from "node:path";
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
 * Run eslint+sonarjs via the Node API (eslint is bundled). Resolves the applicable config PER
 * FILE and runs one pass per config group, so monorepo packages are linted under their own
 * config. Three modes per group:
 *  default → tend's config · layer → project config + sonarjs · defer → project config.
 * Output paths stay relative to the original ctx.cwd so finding IDs/filtering are unaffected.
 */
export async function runEslintSonarjs(ctx: ScanContext): Promise<ScanResult> {
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
