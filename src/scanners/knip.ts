import type { RawFinding } from "../findings/normalize.js";
import { toRepoRelative } from "./paths.js";
import type { Scanner, ScanContext, SpawnResult } from "./scanner.js";

type KnipItem = { name: string; line?: number; col?: number };
type KnipFileEntry = {
  file: string;
  files?: KnipItem[];
  exports?: KnipItem[];
  types?: KnipItem[];
  enumMembers?: KnipItem[];
  dependencies?: KnipItem[];
  devDependencies?: KnipItem[];
  optionalPeerDependencies?: KnipItem[];
  unlisted?: KnipItem[];
  unresolved?: KnipItem[];
};
// knip reports unused FILES as a top-level string array; the per-file `issues` carry
// everything else (unused exports/types/deps). Older/synthetic shapes also nested files
// under an issue entry, so both paths are handled.
type KnipReport = { files?: string[]; issues: KnipFileEntry[] };

/** Each knip issue type → (rule name, human label). */
const ISSUE_TYPES: { key: keyof KnipFileEntry; rule: string; label: string }[] = [
  { key: "files", rule: "unused-file", label: "Unused file" },
  { key: "exports", rule: "unused-export", label: "Unused export" },
  { key: "types", rule: "unused-type", label: "Unused exported type" },
  { key: "enumMembers", rule: "unused-enum-member", label: "Unused enum member" },
  { key: "dependencies", rule: "unused-dependency", label: "Unused dependency" },
  { key: "devDependencies", rule: "unused-dependency", label: "Unused devDependency" },
  { key: "optionalPeerDependencies", rule: "unused-dependency", label: "Unused optional peer dependency" },
  { key: "unlisted", rule: "unlisted-dependency", label: "Unlisted dependency" },
  { key: "unresolved", rule: "unresolved-import", label: "Unresolved import" },
];

export const knipScanner: Scanner = {
  tool: "knip",
  binary: "knip",

  buildArgs(): string[] {
    return ["--reporter", "json", "--no-progress"];
  },

  parse(raw: SpawnResult, ctx: ScanContext): RawFinding[] {
    const report = JSON.parse(raw.stdout) as KnipReport;
    const findings: RawFinding[] = [];

    // Top-level unused files (knip's real shape) — bare path strings, no location.
    for (const path of report.files ?? []) {
      findings.push({
        tool: "knip",
        rule: "unused-file",
        category: "dead-code",
        severity: "warning",
        file: toRepoRelative(ctx.cwd, path),
        range: { startLine: 0, startCol: 0, endLine: 0, endCol: 0 },
        message: `Unused file: ${path}`,
      });
    }

    for (const entry of report.issues ?? []) {
      const file = toRepoRelative(ctx.cwd, entry.file);

      for (const { key, rule, label } of ISSUE_TYPES) {
        const items = entry[key];
        if (!Array.isArray(items)) continue;
        for (const item of items) {
          const line = item.line ?? 0;
          findings.push({
            tool: "knip",
            rule,
            category: "dead-code",
            severity: "warning",
            file,
            range: { startLine: line, startCol: item.col ?? 0, endLine: line, endCol: item.col ?? 0 },
            message: `${label}: ${item.name}`,
          });
        }
      }
    }

    return findings;
  },
};
