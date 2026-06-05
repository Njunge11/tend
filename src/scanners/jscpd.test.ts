import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ScanContext, SpawnResult } from "./scanner.js";
import {
  DEFAULT_JSCPD_IGNORE_PATTERNS,
  jscpdReportPath,
  jscpdScanner,
  mapJscpdReport,
  type JscpdReport,
} from "./jscpd.js";

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../test/fixtures/scanner-outputs/${name}`, import.meta.url)), "utf8");

const ctx: ScanContext = { cwd: "/repo", files: [], loop: 1 };
// jscpd writes its JSON to a file (passed via --output); stdout carries only a status line.
const statusLine: SpawnResult = { stdout: "JSON report saved to …", stderr: "", exitCode: 0 };

describe("mapJscpdReport", () => {
  it("T-028: report → duplication findings with clone locations", () => {
    const findings = mapJscpdReport(JSON.parse(fixture("jscpd.json")) as JscpdReport, ctx);

    expect(findings).toHaveLength(1);
    const dup = findings[0]!;
    expect(dup).toMatchObject({
      tool: "jscpd",
      category: "duplication",
      file: "src/a.ts",
      range: { startLine: 10, endLine: 23, endCol: 2 },
    });
    // the clone's other location is preserved in the message
    expect(dup.message).toContain("src/b.ts");
    expect(dup.message).toContain("45");
    // both clone sites are recorded so the scope filter can match either file
    expect(dup.flowPath).toStrictEqual([
      {
        file: "src/a.ts",
        line: 10,
        range: { startLine: 10, startCol: 1, endLine: 23, endCol: 2 },
      },
      {
        file: "src/b.ts",
        line: 45,
        range: { startLine: 45, startCol: 1, endLine: 58, endCol: 2 },
      },
    ]);
  });

  it("T-032: empty report → []", () => {
    expect(mapJscpdReport({ duplicates: [] }, ctx)).toStrictEqual([]);
  });
});

describe("jscpdScanner.buildArgs", () => {
  it("T-131: directs the report to a tmpdir outside the repo (nothing in the working tree)", () => {
    const args = jscpdScanner.buildArgs(ctx);
    const outIdx = args.indexOf("--output");
    expect(outIdx).toBeGreaterThanOrEqual(0);
    const outDir = args[outIdx + 1]!;
    expect(outDir.startsWith(tmpdir())).toBe(true);
    expect(outDir.startsWith(ctx.cwd)).toBe(false);
    // absolute paths in the report so they survive being relative-to-the-output-dir otherwise
    expect(args).toContain("--absolute");
    expect(args.slice(args.indexOf("--ignore"), args.indexOf("--ignore") + 2)).toStrictEqual([
      "--ignore",
      DEFAULT_JSCPD_IGNORE_PATTERNS.join(","),
    ]);
    // it still scans the whole repo (clone detection needs unchanged files too)
    expect(args).toContain(ctx.cwd);
  });
});

describe("jscpdScanner.parse", () => {
  let dir: string;
  beforeEach(() => {
    // Mirror what buildArgs computes so parse reads from the same place.
    dir = jscpdReportPath(ctx).dir;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("T-132: reads the JSON report from the --output dir, then removes it", () => {
    writeFileSync(jscpdReportPath(ctx).file, fixture("jscpd.json"));

    const findings = jscpdScanner.parse(statusLine, ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ tool: "jscpd", file: "src/a.ts" });
    // the throwaway report dir is cleaned up
    expect(() => readFileSync(jscpdReportPath(ctx).file, "utf8")).toThrow();
  });

  it("T-133: no report file (jscpd writes none when there are zero clones) → []", () => {
    // ensure the dir/file does not exist
    rmSync(dir, { recursive: true, force: true });
    expect(jscpdScanner.parse(statusLine, ctx)).toStrictEqual([]);
  });
});
