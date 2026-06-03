import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ScanContext, SpawnResult } from "./scanner.js";
import { gitleaksScanner } from "./gitleaks.js";

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../test/fixtures/scanner-outputs/${name}`, import.meta.url)), "utf8");

const ctx: ScanContext = { cwd: "/repo", files: [], loop: 1 };
const raw = (stdout: string, exitCode = 1): SpawnResult => ({ stdout, stderr: "", exitCode });

describe("gitleaksScanner.parse", () => {
  it("T-031: fixture → secret findings with location", () => {
    const findings = gitleaksScanner.parse(raw(fixture("gitleaks.json")), ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      tool: "gitleaks",
      category: "secret",
      severity: "error",
      rule: "aws-access-token",
      file: "config/prod.ts",
      range: { startLine: 12, startCol: 19, endLine: 12, endCol: 38 },
    });
  });

  it("T-032: empty output → []", () => {
    expect(gitleaksScanner.parse(raw("[]", 0), ctx)).toStrictEqual([]);
  });
});
