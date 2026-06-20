import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execaNode } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpawnResult } from "./scanner.js";
import { ctx, fixture } from "./_test-helpers.js";
import { eslintSonarjsScanner, runEslintSonarjs, runEslintSonarjsInProcess } from "./eslint-sonarjs.js";

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

  it('treats "." as a whole-repo sentinel instead of passing an empty target to ESLint', async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    writeFileSync(join(dir, "code.js"), DUP_BRANCHES);

    const res = await runEslintSonarjs({ cwd: dir, files: ["."], loop: 1 });

    expect(res.error).toBeUndefined();
    expect(res.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "code.js",
          rule: expect.stringMatching(/^sonarjs\//),
        }),
      ]),
    );
  });

  it("default mode skips generated dirs (dist/) on a whole-repo scan while still linting src/", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    mkdirSync(join(dir, "dist"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "dist", "code.js"), DUP_BRANCHES);
    writeFileSync(join(dir, "src", "code.js"), DUP_BRANCHES);

    const res = await runEslintSonarjs({ cwd: dir, files: ["."], loop: 1 });

    expect(res.error).toBeUndefined();
    const files = res.findings.map((f) => f.file);
    expect(files).toContain("src/code.js"); // sibling src/ file still linted
    expect(files.some((f) => f.startsWith("dist/"))).toBe(false); // dist/ ignored by the default config
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

  it("default mode catches Sonar-way borrowed rules: duplicate imports (S3863) and core rules", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    writeFileSync(join(dir, "m.ts"), "export type Tool = string;\nexport type Finding = { id: string };\n");
    writeFileSync(
      join(dir, "code.ts"),
      [
        'import type { Tool } from "./m.js";',
        'import type { Finding } from "./m.js";', // S3863: same module imported twice
        "var n = 3; // S3504: no-var",
        "export function f(a: Tool | Finding): boolean { return n === n; } // S6679: self-compare",
      ].join("\n"),
    );

    const res = await runEslintSonarjs({ cwd: dir, files: ["code.ts"], loop: 1 });

    const rules = res.findings.map((f) => f.rule);
    expect(res.error).toBeUndefined();
    expect(rules).toContain("import/no-duplicates");
    expect(rules).toContain("no-var");
    expect(rules).toContain("no-self-compare");
  });

  it("borrowed extension rules run as their @typescript-eslint variant on TS files", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    writeFileSync(join(dir, "code.ts"), "const flag = true;\nflag;\nexport default flag;\n");

    const res = await runEslintSonarjs({ cwd: dir, files: ["code.ts"], loop: 1 });

    const rules = res.findings.map((f) => f.rule);
    expect(res.error).toBeUndefined();
    expect(rules).toContain("@typescript-eslint/no-unused-expressions"); // S905 via the TS-aware rule
    expect(rules).not.toContain("no-unused-expressions"); // core variant stays off on TS files
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

// Type-aware lint: a tsconfig.json activates sonarjs's requiresTypeChecking rules (S2871 …),
// with per-file syntactic rescue for anything the TS project service can't cover.
describe("runEslintSonarjs (type-aware mode)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tend-eslint-typed-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // S2871: sorting strings without a comparator — only detectable with type information.
  const SORT_NO_COMPARATOR =
    "export function listFiles(acceptedFiles: Set<string>): string[] {\n  const files = [...acceptedFiles].sort();\n  return files;\n}\n";
  const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, module: "esnext", target: "es2022" } });

  it("catches S2871 (sort without comparator) when the project has a tsconfig", async () => {
    writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
    writeFileSync(join(dir, "code.ts"), SORT_NO_COMPARATOR);

    const res = await runEslintSonarjs({ cwd: dir, files: ["code.ts"], loop: 1 });

    expect(res.error).toBeUndefined();
    expect(res.findings.map((f) => f.rule)).toContain("sonarjs/no-alphabetical-sort");
  });

  it("stays syntactic (no S2871, no error) when there is no tsconfig", async () => {
    writeFileSync(join(dir, "code.ts"), SORT_NO_COMPARATOR);

    const res = await runEslintSonarjs({ cwd: dir, files: ["code.ts"], loop: 1 });

    expect(res.error).toBeUndefined();
    expect(res.findings.map((f) => f.rule)).not.toContain("sonarjs/no-alphabetical-sort");
  });

  it("rescues files outside the tsconfig: typed findings in covered files, syntactic in the rest", async () => {
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ include: ["src"] }));
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "src", "code.ts"), SORT_NO_COMPARATOR);
    // Outside the tsconfig's include → the project service rejects it; the rescue pass must
    // still surface its syntactic finding (duplicated if/else branches).
    writeFileSync(
      join(dir, "scripts", "task.ts"),
      "export function pick(c: boolean): number {\n  if (c) { return 42; } else { return 42; }\n}\n",
    );

    const res = await runEslintSonarjs({ cwd: dir, files: ["src/code.ts", "scripts/task.ts"], loop: 1 });

    expect(res.error).toBeUndefined();
    const byFile = (file: string) => res.findings.filter((f) => f.file === file).map((f) => f.rule);
    expect(byFile("src/code.ts")).toContain("sonarjs/no-alphabetical-sort"); // typed pass
    expect(byFile("scripts/task.ts")).toContain("sonarjs/no-all-duplicated-branches"); // rescued
  });

  it("falls back to syntactic linting when the tsconfig is unparseable", async () => {
    writeFileSync(join(dir, "tsconfig.json"), "{ this is not json");
    writeFileSync(
      join(dir, "code.ts"),
      "export function pick(c: boolean): number {\n  if (c) { return 42; } else { return 42; }\n}\n",
    );

    const res = await runEslintSonarjs({ cwd: dir, files: ["code.ts"], loop: 1 });

    expect(res.error).toBeUndefined();
    expect(res.findings.map((f) => f.rule)).toContain("sonarjs/no-all-duplicated-branches");
  });

  it("TEND_ESLINT_TYPED=0 disables type-aware linting even with a tsconfig", async () => {
    writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
    writeFileSync(join(dir, "code.ts"), SORT_NO_COMPARATOR);

    process.env["TEND_ESLINT_TYPED"] = "0";
    try {
      const res = await runEslintSonarjs({ cwd: dir, files: ["code.ts"], loop: 1 });
      expect(res.error).toBeUndefined();
      expect(res.findings.map((f) => f.rule)).not.toContain("sonarjs/no-alphabetical-sort");
    } finally {
      delete process.env["TEND_ESLINT_TYPED"];
    }
  });

  it("whole-repo scan is typed when a root tsconfig exists", async () => {
    writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
    writeFileSync(join(dir, "code.ts"), SORT_NO_COMPARATOR);

    const res = await runEslintSonarjs({ cwd: dir, files: ["."], loop: 1 });

    expect(res.error).toBeUndefined();
    expect(res.findings.map((f) => f.rule)).toContain("sonarjs/no-alphabetical-sort");
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

describe("runEslintSonarjs — child-process isolation", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tend-eslint-child-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    writeFileSync(join(dir, "code.js"), "export function pick(c) {\n  if (c) { return 42; } else { return 42; }\n}\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("the in-process form produces sonarjs findings (the body the worker child runs)", async () => {
    const res = await runEslintSonarjsInProcess({ cwd: dir, files: ["code.js"], loop: 1 });
    expect(res.error).toBeUndefined();
    expect(res.findings.some((f) => f.rule.startsWith("sonarjs/"))).toBe(true);
  });

  it("TEND_ESLINT_INPROCESS=1 forces the in-process path and still returns findings", async () => {
    const prev = process.env["TEND_ESLINT_INPROCESS"];
    process.env["TEND_ESLINT_INPROCESS"] = "1";
    try {
      const res = await runEslintSonarjs({ cwd: dir, files: ["code.js"], loop: 1 });
      expect(res.findings.some((f) => f.rule.startsWith("sonarjs/"))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env["TEND_ESLINT_INPROCESS"];
      else process.env["TEND_ESLINT_INPROCESS"] = prev;
    }
  });

  // Real end-to-end coverage of the forked-worker contract, only when the worker has been built.
  // Forks the actual worker, drives one scan over its IPC channel, and asserts it both returns
  // findings AND stays alive for a SECOND scan (the warm-program reuse that makes it persistent) —
  // proof the heavy lint runs out-of-process. Skipped on a source-only run (no dist/), which is
  // fine: the public function falls back to in-process there and the two tests above cover it.
  const builtWorker = join(process.cwd(), "dist", "scanners", "eslint-worker.js");
  it.runIf(existsSync(builtWorker))("the persistent worker answers scans over execa IPC and is reusable", async () => {
    const child = execaNode(builtWorker, [], { ipc: true, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    type Reply = { id: number; result?: { findings: { rule: string }[] }; error?: string };
    const scan = async (id: number): Promise<Reply> => {
      await child.sendMessage({ id, ctx: { cwd: dir, files: ["code.js"], loop: 1 } });
      return (await child.getOneMessage({ filter: (m) => (m as Reply).id === id })) as Reply;
    };
    try {
      const first = await scan(1);
      expect(first.error).toBeUndefined();
      expect(first.result?.findings.some((f) => f.rule.startsWith("sonarjs/"))).toBe(true);
      // Reuse: the same warm worker answers a second scan (it did not exit after the first).
      const second = await scan(2);
      expect(second.result?.findings.some((f) => f.rule.startsWith("sonarjs/"))).toBe(true);
    } finally {
      child.kill();
      await child.catch(() => undefined);
    }
  });
});
