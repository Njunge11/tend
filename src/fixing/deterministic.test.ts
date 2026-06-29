import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    exists(rel: string): boolean {
      return existsSync(join(dir, rel));
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

  it("deletes knip unused-file findings without starting an AI session", async () => {
    env.write("src/unused.ts", "export const unused = 1;\n");
    const finding = makeFinding({
      tool: "knip",
      rule: "unused-file",
      category: "dead-code",
      file: "src/unused.ts",
      message: "Unused file: src/unused.ts",
    });
    const scanFindings = vi.fn(async () => []);

    const outcome = await makeDeterministicFixUnit(deps({ scanFindings }))(
      unit("src/unused.ts", finding, "deterministic-unused-file-delete"),
    );

    expect(outcome.kept).toBe(true);
    expect(outcome.usage?.sessions).toBe(0);
    expect(env.exists("src/unused.ts")).toBe(false);
    expect(scanFindings).toHaveBeenCalledWith(["src/unused.ts"], ["knip"]);
  });

  it("restores a deleted unused file when the gate fails", async () => {
    const original = "export const unused = 1;\n";
    env.write("src/unused.ts", original);
    const finding = makeFinding({
      tool: "knip",
      rule: "unused-file",
      category: "dead-code",
      file: "src/unused.ts",
      message: "Unused file: src/unused.ts",
    });

    const outcome = await makeDeterministicFixUnit(deps({ typescript: true, runTsc: async () => ({ exitCode: 1, output: "boom" }) }))(
      unit("src/unused.ts", finding, "deterministic-unused-file-delete"),
    );

    expect(outcome.kept).toBe(false);
    expect(outcome.reason).toBe("typecheck");
    expect(env.exists("src/unused.ts")).toBe(true);
    expect(env.read("src/unused.ts")).toBe(original);
  });

  it("deletes an unreferenced knip unused exported type without AI usage", async () => {
    env.write("src/root.ts", "export const appRouter = {};\n\nexport type AppRouter = typeof appRouter;\n");
    const finding = makeFinding({
      tool: "knip",
      rule: "unused-type",
      category: "dead-code",
      file: "src/root.ts",
      message: "Unused exported type: AppRouter",
    });

    const outcome = await makeDeterministicFixUnit(deps())(
      unit("src/root.ts", finding, "deterministic-ts-unused-export-cleanup"),
    );

    expect(outcome.kept).toBe(true);
    expect(outcome.usage?.sessions).toBe(0);
    expect(env.read("src/root.ts")).toBe("export const appRouter = {};");
  });

  it("removes only the export modifier when an unused export is referenced in-file", async () => {
    env.write("src/helpers.ts", "export function helper() {\n  return 1;\n}\n\nexport const value = helper();\n");
    const finding = makeFinding({
      tool: "knip",
      rule: "unused-export",
      category: "dead-code",
      file: "src/helpers.ts",
      message: "Unused export: helper",
    });

    const outcome = await makeDeterministicFixUnit(deps())(
      unit("src/helpers.ts", finding, "deterministic-ts-unused-export-cleanup"),
    );

    expect(outcome.kept).toBe(true);
    expect(env.read("src/helpers.ts")).toBe("function helper() {\n  return 1;\n}\n\nexport const value = helper();\n");
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

  it("removes a re-export specifier (`export { x }`) and leaves the local binding", async () => {
    env.write("src/barrel.ts", "import { modelFor } from './m';\nexport { modelFor };\n");
    const finding = makeFinding({
      tool: "knip",
      rule: "unused-export",
      category: "dead-code",
      file: "src/barrel.ts",
      message: "Unused export: modelFor",
    });

    const outcome = await makeDeterministicFixUnit(deps())(
      unit("src/barrel.ts", finding, "deterministic-ts-unused-export-cleanup"),
    );

    expect(outcome.kept).toBe(true);
    expect(env.read("src/barrel.ts")).toBe("import { modelFor } from './m';");
  });

  it("removes a type-only re-export specifier (`export type { T }`)", async () => {
    env.write("src/ports.ts", "import type { Action } from './actions';\nexport type { Action };\n");
    const finding = makeFinding({
      tool: "knip",
      rule: "unused-type",
      category: "dead-code",
      file: "src/ports.ts",
      message: "Unused exported type: Action",
    });

    const outcome = await makeDeterministicFixUnit(deps())(
      unit("src/ports.ts", finding, "deterministic-ts-unused-export-cleanup"),
    );

    expect(outcome.kept).toBe(true);
    expect(env.read("src/ports.ts")).toBe("import type { Action } from './actions';");
  });

  it("drops only the unused name from a multi-specifier re-export", async () => {
    env.write("src/barrel.ts", "export { a, b, c };\n");
    const finding = makeFinding({
      tool: "knip",
      rule: "unused-export",
      category: "dead-code",
      file: "src/barrel.ts",
      message: "Unused export: b",
    });

    const outcome = await makeDeterministicFixUnit(deps())(
      unit("src/barrel.ts", finding, "deterministic-ts-unused-export-cleanup"),
    );

    expect(outcome.kept).toBe(true);
    expect(env.read("src/barrel.ts")).toBe("export { a, c };\n");
  });

  it("rebuilds the clause once when several names in one re-export are unused", async () => {
    env.write("src/barrel.ts", "export { a, b, c };\n");
    const findings = [
      makeFinding({ tool: "knip", rule: "unused-export", category: "dead-code", file: "src/barrel.ts", message: "Unused export: a" }),
      makeFinding({ tool: "knip", rule: "unused-export", category: "dead-code", file: "src/barrel.ts", message: "Unused export: c" }),
    ];

    const outcome = await makeDeterministicFixUnit(deps())({
      file: "src/barrel.ts",
      files: ["src/barrel.ts"],
      findings,
      strategy: "deterministic-ts-unused-export-cleanup",
      strategies: ["deterministic-ts-unused-export-cleanup"],
      verificationTargets: ["src/barrel.ts"],
    });

    expect(outcome.kept).toBe(true);
    expect(env.read("src/barrel.ts")).toBe("export { b };\n");
  });

  it("deletes the whole re-export statement when every name is unused", async () => {
    env.write("src/barrel.ts", "const a = 1;\nexport { a };\n");
    const finding = makeFinding({
      tool: "knip",
      rule: "unused-export",
      category: "dead-code",
      file: "src/barrel.ts",
      message: "Unused export: a",
    });

    const outcome = await makeDeterministicFixUnit(deps())(
      unit("src/barrel.ts", finding, "deterministic-ts-unused-export-cleanup"),
    );

    expect(outcome.kept).toBe(true);
    expect(env.read("src/barrel.ts")).toBe("const a = 1;");
  });

  it("drops one unused name from a destructured `export const { ... } = expr` (the auth.ts case)", async () => {
    // Verbatim shape that failed in apps/admin/auth.ts: NextAuth() returns an object that is
    // destructured and re-exported; knip flags `signIn` as unused. The unrelated `signIn` callback
    // key inside the config must NOT be treated as a local reference.
    env.write(
      "src/auth.ts",
      [
        'import NextAuth from "next-auth";',
        "export const { handlers, auth, signIn, signOut } = NextAuth({",
        "  callbacks: {",
        "    async signIn({ profile }) {",
        "      return Boolean(profile);",
        "    },",
        "  },",
        "});",
        "",
      ].join("\n"),
    );
    const finding = makeFinding({
      tool: "knip",
      rule: "unused-export",
      category: "dead-code",
      file: "src/auth.ts",
      message: "Unused export: signIn",
    });

    const outcome = await makeDeterministicFixUnit(deps())(
      unit("src/auth.ts", finding, "deterministic-ts-unused-export-cleanup"),
    );

    expect(outcome.kept).toBe(true);
    expect(env.read("src/auth.ts")).toBe(
      [
        'import NextAuth from "next-auth";',
        "export const { handlers, auth, signOut } = NextAuth({",
        "  callbacks: {",
        "    async signIn({ profile }) {",
        "      return Boolean(profile);",
        "    },",
        "  },",
        "});",
        "",
      ].join("\n"),
    );
  });

  it("rebuilds a destructured pattern once when several of its names are unused", async () => {
    env.write("src/api.ts", "export const { a, b, c } = make();\n");
    const findings = [
      makeFinding({ tool: "knip", rule: "unused-export", category: "dead-code", file: "src/api.ts", message: "Unused export: a" }),
      makeFinding({ tool: "knip", rule: "unused-export", category: "dead-code", file: "src/api.ts", message: "Unused export: c" }),
    ];

    const outcome = await makeDeterministicFixUnit(deps())({
      file: "src/api.ts",
      files: ["src/api.ts"],
      findings,
      strategy: "deterministic-ts-unused-export-cleanup",
      strategies: ["deterministic-ts-unused-export-cleanup"],
      verificationTargets: ["src/api.ts"],
    });

    expect(outcome.kept).toBe(true);
    expect(env.read("src/api.ts")).toBe("export const { b } = make();\n");
  });

  it("deletes the whole statement when every destructured name is unused", async () => {
    env.write("src/api.ts", "export const { a, b } = make();\n");
    const findings = [
      makeFinding({ tool: "knip", rule: "unused-export", category: "dead-code", file: "src/api.ts", message: "Unused export: a" }),
      makeFinding({ tool: "knip", rule: "unused-export", category: "dead-code", file: "src/api.ts", message: "Unused export: b" }),
    ];

    const outcome = await makeDeterministicFixUnit(deps())({
      file: "src/api.ts",
      files: ["src/api.ts"],
      findings,
      strategy: "deterministic-ts-unused-export-cleanup",
      strategies: ["deterministic-ts-unused-export-cleanup"],
      verificationTargets: ["src/api.ts"],
    });

    expect(outcome.kept).toBe(true);
    expect(env.read("src/api.ts")).toBe("");
  });

  it("refuses (terminally) to drop a destructured binding that is still used locally", async () => {
    env.write("src/api.ts", "export const { a, b } = make();\nconsole.log(a);\n");
    const finding = makeFinding({
      tool: "knip",
      rule: "unused-export",
      category: "dead-code",
      file: "src/api.ts",
      message: "Unused export: a",
    });

    const outcome = await makeDeterministicFixUnit(deps())(
      unit("src/api.ts", finding, "deterministic-ts-unused-export-cleanup"),
    );

    expect(outcome.kept).toBe(false);
    expect(outcome.reason).toBe("deterministic-unsupported");
    expect(env.read("src/api.ts")).toBe("export const { a, b } = make();\nconsole.log(a);\n");
  });

  it("fails an unsupported export shape terminally, not as a retryable session error", async () => {
    env.write("src/barrel.ts", "export * from './m';\n");
    const finding = makeFinding({
      tool: "knip",
      rule: "unused-export",
      category: "dead-code",
      file: "src/barrel.ts",
      message: "Unused export: anything",
    });

    const outcome = await makeDeterministicFixUnit(deps())(
      unit("src/barrel.ts", finding, "deterministic-ts-unused-export-cleanup"),
    );

    expect(outcome.kept).toBe(false);
    expect(outcome.reason).toBe("deterministic-unsupported");
    expect(outcome.failureClass).toBe("deterministic-unsupported");
    expect(outcome.usage?.sessions).toBe(0);
    expect(env.read("src/barrel.ts")).toBe("export * from './m';\n");
  });
});
