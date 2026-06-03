import { ESLint } from "eslint";
import sonarjs from "eslint-plugin-sonarjs";
import { normalize, type RawFinding } from "../findings/normalize.js";
import { defaultEslintConfigPath, eslintMode } from "./eslint-default-config.js";
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
};
type EslintResult = { filePath: string; messages: EslintMessage[] };

/** Map ESLint results (CLI JSON or Node-API LintResult[]) into tend's RawFindings. */
export function mapEslintResults(results: EslintResult[], ctx: ScanContext): RawFinding[] {
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

/**
 * Run eslint+sonarjs via the Node API (eslint is bundled) so we can layer sonarjs ON TOP of a
 * project's own eslint config — which the CLI `--config` flag can't do (it replaces). Three modes:
 *  default → tend's config · layer → project config + sonarjs · defer → project config.
 */
export async function runEslintSonarjs(ctx: ScanContext): Promise<ScanResult> {
  const mode = eslintMode(ctx.cwd);
  const targets = ctx.files.length > 0 ? ctx.files : ["."];

  const options: ESLint.Options = { cwd: ctx.cwd, errorOnUnmatchedPattern: false };
  if (mode === "default") {
    options.overrideConfigFile = defaultEslintConfigPath();
  } else if (mode === "layer") {
    options.overrideConfig = [sonarjs.configs.recommended];
  }

  try {
    const eslint = new ESLint(options);
    const results = (await eslint.lintFiles(targets)) as EslintResult[];
    const findings = mapEslintResults(results, ctx).map((r) => normalize(r, ctx.loop));
    return { tool: "sonarjs", findings, skipped: false };
  } catch (err) {
    return { tool: "sonarjs", findings: [], skipped: false, error: err instanceof Error ? err.message : String(err) };
  }
}
