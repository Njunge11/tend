import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ScanContext, SpawnResult } from "./scanner.js";
import { eslintSonarjsScanner, runEslintSonarjs } from "./eslint-sonarjs.js";

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../test/fixtures/scanner-outputs/${name}`, import.meta.url)), "utf8");

const ctx: ScanContext = { cwd: "/repo", files: [], loop: 1 };
const raw = (stdout: string, exitCode = 1): SpawnResult => ({ stdout, stderr: "", exitCode });

describe("eslintSonarjsScanner.parse", () => {
  it("T-027: fixture → findings with rule, severity, range", () => {
    const findings = eslintSonarjsScanner.parse(raw(fixture("eslint-sonarjs.json")), ctx);

    // the null-ruleId parse-error message is dropped; two real rule violations remain
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.tool === "sonarjs")).toBe(true);

    const identical = findings.find((f) => f.rule === "sonarjs/no-identical-expressions");
    expect(identical).toMatchObject({
      severity: "error",
      file: "src/calc.ts",
      range: { startLine: 14, startCol: 7, endLine: 14, endCol: 27 },
    });

    const complexity = findings.find((f) => f.rule === "sonarjs/cognitive-complexity");
    expect(complexity?.severity).toBe("warning");
  });

  it("T-032: empty output → []", () => {
    expect(eslintSonarjsScanner.parse(raw("[]", 0), ctx)).toStrictEqual([]);
  });
});

// Real ESLint Node-API runs on throwaway projects — proves the three modes end-to-end.
describe("runEslintSonarjs (Node API, bundled eslint)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tend-eslint-run-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const DUP_BRANCHES = "export function pick(c) {\n  if (c) { return 42; } else { return 42; }\n}\n";

  it("default mode (no project config) → sonarjs findings via tend's config", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    writeFileSync(join(dir, "code.js"), DUP_BRANCHES);

    const res = await runEslintSonarjs({ cwd: dir, files: ["code.js"], loop: 1 });

    expect(res.error).toBeUndefined();
    expect(res.findings.some((f) => f.rule.startsWith("sonarjs/"))).toBe(true);
  });

  it("layer mode → project's own rules AND sonarjs in one pass", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    writeFileSync(join(dir, "eslint.config.mjs"), 'export default [{ rules: { "no-unused-vars": "error" } }];\n');
    writeFileSync(join(dir, "code.js"), "export function pick(c) {\n  const unused = 1;\n  if (c) { return 42; } else { return 42; }\n}\n");

    const res = await runEslintSonarjs({ cwd: dir, files: ["code.js"], loop: 1 });

    const rules = res.findings.map((f) => f.rule);
    expect(rules).toContain("no-unused-vars"); // their rule
    expect(rules.some((r) => r.startsWith("sonarjs/"))).toBe(true); // our layer
  });
});
