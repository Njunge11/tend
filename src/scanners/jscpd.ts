import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawFinding } from "../findings/normalize.js";
import { toRepoRelative } from "./paths.js";
import type { Scanner, ScanContext, SpawnResult } from "./scanner.js";

type JscpdLoc = { line: number; column?: number };
type JscpdFile = { name: string; start: number; end: number; startLoc?: JscpdLoc; endLoc?: JscpdLoc };
type JscpdDuplicate = {
  format: string;
  lines: number;
  firstFile: JscpdFile;
  secondFile: JscpdFile;
};
export type JscpdReport = { duplicates: JscpdDuplicate[] };

/**
 * Where jscpd's JSON report lives for this loop: a throwaway dir OUTSIDE the repo, so the
 * `--reporters json` file never dirties the user's working tree. Deterministic in (pid, loop)
 * so `buildArgs` (which creates it) and `parse` (which reads it) agree without shared state.
 */
export function jscpdReportPath(ctx: ScanContext): { dir: string; file: string } {
  const dir = join(tmpdir(), `tend-jscpd-${process.pid}-loop${ctx.loop}`);
  return { dir, file: join(dir, "jscpd-report.json") };
}

/** Turn a parsed jscpd report into duplication findings. Pure — no IO. */
export function mapJscpdReport(report: JscpdReport, ctx: ScanContext): RawFinding[] {
  return (report.duplicates ?? []).map((dup) => {
    const first = dup.firstFile;
    const second = dup.secondFile;
    const file = toRepoRelative(ctx.cwd, first.name);
    const cloneFile = toRepoRelative(ctx.cwd, second.name);

    return {
      tool: "jscpd",
      rule: "duplicate-code",
      category: "duplication",
      severity: "warning",
      file,
      range: {
        startLine: first.start,
        startCol: first.startLoc?.column ?? 0,
        endLine: first.end,
        endCol: second.endLoc?.column ?? 0,
      },
      message: `Duplicated ${dup.lines} lines, also at ${cloneFile}:${second.start}-${second.end}`,
      // Both clone sites, so the changed-files scope filter can keep the clone when EITHER
      // file changed (a finding records only firstFile as `.file`).
      flowPath: [
        { file, line: first.start },
        { file: cloneFile, line: second.start },
      ],
    } satisfies RawFinding;
  });
}

export const jscpdScanner: Scanner = {
  tool: "jscpd",
  binary: "jscpd",

  buildArgs(ctx: ScanContext): string[] {
    const { dir } = jscpdReportPath(ctx);
    mkdirSync(dir, { recursive: true });
    // --absolute: emit absolute paths (otherwise they'd be relative to --output, outside the repo).
    // --output <tmpdir>: keep the report file out of the user's working tree.
    // ctx.cwd: scan the whole repo — clone detection needs the unchanged files too.
    return ["--absolute", "--reporters", "json", "--silent", "--output", dir, ctx.cwd];
  },

  parse(_raw: SpawnResult, ctx: ScanContext): RawFinding[] {
    const { dir, file } = jscpdReportPath(ctx);
    let json: string;
    try {
      json = readFileSync(file, "utf8");
    } catch {
      // jscpd writes no report file when it finds zero clones → no duplication.
      return [];
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return mapJscpdReport(JSON.parse(json) as JscpdReport, ctx);
  },
};
