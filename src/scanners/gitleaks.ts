import type { RawFinding } from "../findings/normalize.js";
import { toRepoRelative } from "./paths.js";
import type { Scanner, ScanContext, SpawnResult } from "./scanner.js";

type GitleaksFinding = {
  RuleID: string;
  Description: string;
  File: string;
  StartLine: number;
  EndLine: number;
  StartColumn: number;
  EndColumn: number;
};

export const gitleaksScanner: Scanner = {
  tool: "gitleaks",
  binary: "gitleaks",

  buildArgs(): string[] {
    // report to stdout; "git" mode scans history (where secrets actually live)
    return ["git", "--report-format", "json", "--report-path", "/dev/stdout", "--no-banner"];
  },

  parse(raw: SpawnResult, ctx: ScanContext): RawFinding[] {
    const report = JSON.parse(raw.stdout) as GitleaksFinding[];

    return report.map((f) => ({
      tool: "gitleaks",
      rule: f.RuleID,
      category: "secret",
      severity: "error",
      file: toRepoRelative(ctx.cwd, f.File),
      range: {
        startLine: f.StartLine,
        startCol: f.StartColumn,
        endLine: f.EndLine,
        endCol: f.EndColumn,
      },
      message: f.Description,
    }));
  },
};
