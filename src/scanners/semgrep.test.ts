import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ScanContext, SpawnResult } from "./scanner.js";
import { semgrepScanner } from "./semgrep.js";

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../test/fixtures/scanner-outputs/${name}`, import.meta.url)), "utf8");

const ctx: ScanContext = { cwd: "/repo", files: [], loop: 1 };
const raw = (stdout: string): SpawnResult => ({ stdout, stderr: "", exitCode: 0 });

describe("semgrepScanner.parse", () => {
  it("T-029: fixture → security findings with flowPath (source→sink)", () => {
    const findings = semgrepScanner.parse(raw(fixture("semgrep.json")), ctx);

    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f).toMatchObject({
      tool: "semgrep",
      category: "security",
      severity: "error",
      file: "src/api/users.ts",
      rule: "typescript.express.security.injection.tainted-sql-string",
      range: { startLine: 14 },
    });

    // flow path runs from the tainted source (line 11) to the sink (line 14)
    expect(f.flowPath?.[0]).toStrictEqual({ file: "src/api/users.ts", line: 11 });
    expect(f.flowPath?.at(-1)).toStrictEqual({ file: "src/api/users.ts", line: 14 });
  });

  it("T-032: empty output → []", () => {
    expect(semgrepScanner.parse(raw('{"results":[],"errors":[]}'), ctx)).toStrictEqual([]);
  });
});
