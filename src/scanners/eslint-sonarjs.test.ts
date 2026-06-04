import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpawnResult } from "./scanner.js";
import { ctx, fixture } from "./_test-helpers.js";
import { eslintSonarjsScanner, runEslintSonarjs } from "./eslint-sonarjs.js";
// Type-only import makes the fixture reachable in the module graph (knip).
import type { Greeter as _Greeter } from "../../test/fixtures/monorepo/apps/dashboard/sample.js";

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
  const UNUSED_AND_DUP = "export function pick(c) {\n  const unused = 1;\n  if (c) { return 42; } else { return 42; }\n}\n";

  async function lintCodeJs(content: string) {
    writeFileSync(join(dir, "code.js"), content);
    const res = await runEslintSonarjs({ cwd: dir, files: ["code.js"], loop: 1 });
    return { res, rules: res.findings.map((f) => f.rule) };
  }

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

    const { rules } = await lintCodeJs(UNUSED_AND_DUP);

    expect(rules).toContain("no-unused-vars"); // their rule
    expect(rules.some((r) => r.startsWith("sonarjs/"))).toBe(true); // our layer
  });

  it("defer mode → project that already configures sonarjs is used as-is (no extra layer)", async () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", devDependencies: { "eslint-plugin-sonarjs": "^3.0.1" } }),
    );
    // Config references sonarjs (here in a comment) and the plugin is a declared dep → tend
    // treats this project as already configuring sonarjs and defers, layering nothing.
    writeFileSync(
      join(dir, "eslint.config.mjs"),
      '// sonarjs is wired up by this project itself\nexport default [{ rules: { "no-unused-vars": "error" } }];\n',
    );

    const { res, rules } = await lintCodeJs(UNUSED_AND_DUP);

    expect(res.error).toBeUndefined();
    expect(rules).toContain("no-unused-vars"); // their rule still runs
    expect(rules.some((r) => r.startsWith("sonarjs/"))).toBe(false); // tend did NOT layer sonarjs
  });

  it("default mode lints TS via the TS-aware unused-vars rule, not the bogus core rule", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    writeFileSync(
      join(dir, "code.ts"),
      "export interface Greeter {\n  greet(name: string): void;\n}\nconst _ok = 1;\nexport function f(): number {\n  const dead = 3;\n  return 1;\n}\n",
    );

    const res = await runEslintSonarjs({ cwd: dir, files: ["code.ts"], loop: 1 });

    const rules = res.findings.map((f) => f.rule);
    expect(res.error).toBeUndefined();
    expect(rules).not.toContain("no-unused-vars"); // core rule disabled for TS
    expect(rules).toContain("@typescript-eslint/no-unused-vars"); // `dead` caught by the TS-aware rule
  });
});

// A real monorepo layout: repo root has no eslint config, apps/dashboard has its own.
describe("runEslintSonarjs (per-file config resolution in a monorepo)", () => {
  const monorepoRoot = fileURLToPath(new URL("../../test/fixtures/monorepo", import.meta.url));
  const dashboardConfig = fileURLToPath(
    new URL("../../test/fixtures/monorepo/apps/dashboard/eslint.config.mjs", import.meta.url),
  );

  it("uses apps/dashboard/eslint.config.mjs when run from the repo root", async () => {
    expect(existsSync(dashboardConfig)).toBe(true);

    const res = await runEslintSonarjs({
      cwd: monorepoRoot,
      files: ["apps/dashboard/sample.ts"],
      loop: 1,
    });

    expect(res.error).toBeUndefined();
    const rules = res.findings.map((f) => f.rule);
    // The project config sets "no-unused-vars: off"; the interface method param in the fixture
    // would trigger the core rule without that override.  Absence proves apps/dashboard's config
    // was resolved rather than tend's bundled fallback (which also disables it) or no config.
    expect(rules).not.toContain("no-unused-vars");
    // The package-only eqeqeq rule proves apps/dashboard's config was used, and the sonarjs
    // finding proves tend layered sonarjs over that config.
    expect(rules).toContain("eqeqeq");
    expect(rules).toContain("sonarjs/no-all-duplicated-branches");
    expect(res.findings.find((f) => f.rule === "eqeqeq")?.file).toBe("apps/dashboard/sample.ts");
  });
});
