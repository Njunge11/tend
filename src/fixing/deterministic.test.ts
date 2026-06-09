import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFinding } from "../../test/helpers/make-finding.js";
import type { Finding } from "../findings/finding.js";
import type { WorkUnit } from "./dispatch.js";
import { makeDeterministicFixUnit, type DeterministicFixUnitDeps } from "./deterministic.js";

function createTempEnv(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    write(rel: string, contents: string): void {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, contents);
    },
    read(rel: string): string {
      return readFileSync(join(dir, rel), "utf8");
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let env: ReturnType<typeof createTempEnv>;

beforeEach(() => {
  env = createTempEnv("tend-deterministic-");
});

afterEach(() => env.cleanup());

function deps(overrides: Partial<DeterministicFixUnitDeps> = {}): DeterministicFixUnitDeps {
  return {
    cwd: env.dir,
    typescript: false,
    runTsc: async () => ({ exitCode: 0, output: "" }),
    hasTestRunner: false,
    runRelated: async () => [],
    scanFindings: async () => [],
    baseline: new Set<string>(),
    ...overrides,
  };
}

function unit(file: string, finding: Finding, strategy: WorkUnit["strategy"]): WorkUnit {
  return {
    file,
    files: [file],
    findings: [finding],
    strategy,
    strategies: strategy ? [strategy] : [],
    verificationTargets: [file],
  };
}

describe("deterministic fixers", () => {
  it("applies ESLint autofixes for current-unit findings without AI usage", async () => {
    env.write("package.json", JSON.stringify({ name: "x", type: "module" }));
    env.write(
      "eslint.config.mjs",
      'export default [{ languageOptions: { ecmaVersion: 2022 }, rules: { curly: ["error", "all"] } }];\n',
    );
    env.write("src/a.js", "if (ok) call();\n");
    const finding = makeFinding({
      tool: "sonarjs",
      rule: "curly",
      file: "src/a.js",
      range: { startLine: 1, startCol: 1, endLine: 1, endCol: 13 },
      message: "Expected { after if condition.",
      autofixable: true,
    });

    const outcome = await makeDeterministicFixUnit(deps())(unit("src/a.js", finding, "deterministic-eslint-fix"));

    expect(outcome).toMatchObject({ kept: true, usage: { sessions: 0 } });
    expect(env.read("src/a.js")).toContain("if (ok) {");
  });

  it("organizes imports for target TypeScript files and runs the targeted re-scan", async () => {
    env.write("src/a.ts", "import { readFileSync, writeFileSync } from 'node:fs';\n\nexport const x = readFileSync;\n");
    const finding = makeFinding({
      tool: "sonarjs",
      rule: "@typescript-eslint/no-unused-vars",
      file: "src/a.ts",
      message: "'writeFileSync' is defined but never used.",
    });
    const scanFindings = vi.fn(async () => []);

    const outcome = await makeDeterministicFixUnit(deps({ scanFindings }))(
      unit("src/a.ts", finding, "deterministic-ts-organize-imports"),
    );

    expect(outcome.kept).toBe(true);
    expect(outcome.usage?.sessions).toBe(0);
    expect(env.read("src/a.ts")).toBe("import { readFileSync } from 'node:fs';\n\nexport const x = readFileSync;\n");
    expect(scanFindings).toHaveBeenCalledWith(["src/a.ts"], ["sonarjs"]);
  });

  it("removes an exact unused dependency from package.json when no lockfile is present", async () => {
    env.write(
      "package.json",
      JSON.stringify({ name: "x", dependencies: { jquery: "^3.7.1", react: "^19.0.0" } }, null, 2) + "\n",
    );
    const finding = makeFinding({
      tool: "knip",
      rule: "unused-dependency",
      category: "dead-code",
      file: "package.json",
      message: "Unused dependency: jquery",
    });

    const outcome = await makeDeterministicFixUnit(deps())(
      unit("package.json", finding, "deterministic-package-json-cleanup"),
    );

    expect(outcome.kept).toBe(true);
    expect(JSON.parse(env.read("package.json")).dependencies).toStrictEqual({ react: "^19.0.0" });
    expect(outcome.usage?.sessions).toBe(0);
  });

  it("marks package cleanup as needing a lockfile update and reverts package.json", async () => {
    const original = JSON.stringify({ name: "x", devDependencies: { vitest: "^4.0.0" } }, null, 2) + "\n";
    env.write("package.json", original);
    env.write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    const finding = makeFinding({
      tool: "knip",
      rule: "unused-dependency",
      category: "dead-code",
      file: "package.json",
      message: "Unused devDependency: vitest",
    });

    const outcome = await makeDeterministicFixUnit(deps())(
      unit("package.json", finding, "deterministic-package-json-cleanup"),
    );

    expect(outcome.kept).toBe(false);
    expect(outcome.reason).toBe("needs-lockfile-update");
    expect(outcome.usage?.sessions).toBe(0);
    expect(env.read("package.json")).toBe(original);
  });

  it("fails explicitly when a deterministic fixer changes nothing", async () => {
    env.write("src/a.ts", "export const x = 1;\n");
    const finding = makeFinding({
      tool: "sonarjs",
      rule: "@typescript-eslint/no-unused-vars",
      file: "src/a.ts",
      message: "Unused import",
    });

    const outcome = await makeDeterministicFixUnit(deps())(
      unit("src/a.ts", finding, "deterministic-ts-organize-imports"),
    );

    expect(outcome.kept).toBe(false);
    expect(outcome.reason).toBe("session-error");
    expect(outcome.detail).toBe("Deterministic fixer completed without changing owned files");
    expect(outcome.usage?.sessions).toBe(0);
  });
});
