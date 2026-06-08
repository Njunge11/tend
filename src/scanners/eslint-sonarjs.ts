import { dirname, relative, resolve } from "node:path";
import { ESLint, type Linter } from "eslint";
import sonarjs from "eslint-plugin-sonarjs";
import type { Finding } from "../findings/finding.js";
import { normalize, type RawFinding } from "../findings/normalize.js";
import {
  defaultEslintConfigPath,
  eslintMode,
  findEslintConfigDir,
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
};

function relativeLintTarget(from: string, to: string): string {
  return relative(from, to) || ".";
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
      };
    }
    return {
      configDir: key,
      mode: projectConfiguresSonarjs(key) ? "defer" : "layer",
      cwd: key,
      targets: absFiles.map((f) => relativeLintTarget(key, f)),
    };
  });
}

/** Lint one group through the Node API; ESLint returns absolute filePaths regardless of cwd. */
function eslintOptionsForGroup(group: LintGroup): ESLint.Options {
  const options: ESLint.Options = { cwd: group.cwd, errorOnUnmatchedPattern: false };
  if (group.mode === "default") {
    options.overrideConfigFile = defaultEslintConfigPath();
  } else if (group.mode === "layer") {
    // Append sonarjs ON TOP of the project's discovered config (the CLI `--config` flag can't —
    // it replaces). `defer` adds nothing: the project already configures sonarjs itself.
    options.overrideConfig = [sonarjs.configs.recommended];
  }
  return options;
}

async function lintGroup(group: LintGroup): Promise<EslintResult[]> {
  const eslint = new ESLint(eslintOptionsForGroup(group));
  return (await eslint.lintFiles(group.targets)) as EslintResult[];
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
  const groups: LintGroup[] =
    ctx.files.length === 0 || ctx.files.includes(".")
      ? [{ configDir: null, mode: eslintMode(ctx.cwd), cwd: ctx.cwd, targets: ["."] }]
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
