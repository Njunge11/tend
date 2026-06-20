import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ScanContext, ScanResult, SpawnResult } from "./scanner.js";
import { ctx, fixture } from "./_test-helpers.js";
import {
  disposeEslintWorker,
  EslintWorker,
  eslintSonarjsScanner,
  runEslintSonarjs,
  runEslintSonarjsInProcess,
  type EslintScanWorker,
} from "./eslint-sonarjs.js";

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

/**
 * The public function's job is to DELEGATE to a worker and shape the outcome: pass a success
 * straight through, degrade a failure into a scanner-error result (never throw), and fall back to
 * an in-process scan when there is no worker. Tested with an injected stub worker so the contract
 * holds regardless of how the real worker is implemented.
 */
describe("runEslintSonarjs — delegation contract", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tend-eslint-deleg-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    writeFileSync(join(dir, "code.js"), "export function pick(c) {\n  if (c) { return 42; } else { return 42; }\n}\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const SCAN: ScanContext = { cwd: "/anywhere", files: ["a.ts"], loop: 1 };

  it("passes the worker's successful result straight through", async () => {
    const out: ScanResult = { tool: "sonarjs", findings: [], skipped: false };
    const worker: EslintScanWorker = { scan: async () => out };
    expect(await runEslintSonarjs(SCAN, worker)).toBe(out);
  });

  it("degrades a worker failure into an error result instead of throwing", async () => {
    const worker: EslintScanWorker = {
      scan: () => Promise.reject(new Error("worker died")),
    };
    expect(await runEslintSonarjs(SCAN, worker)).toEqual({
      tool: "sonarjs",
      findings: [],
      skipped: false,
      error: "worker died",
    });
  });

  it("degrades a non-Error rejection by stringifying it", async () => {
    const worker: EslintScanWorker = {
      // eslint-disable-next-line prefer-promise-reject-errors
      scan: () => Promise.reject("plain string failure"),
    };
    const res = await runEslintSonarjs(SCAN, worker);
    expect(res.error).toBe("plain string failure");
    expect(res.findings).toEqual([]);
  });

  it("falls back to a real in-process scan when there is no worker", async () => {
    const res = await runEslintSonarjs({ cwd: dir, files: ["code.js"], loop: 1 }, null);
    expect(res.error).toBeUndefined();
    expect(res.findings.some((f) => f.rule.startsWith("sonarjs/"))).toBe(true);
  });

  it("TEND_ESLINT_INPROCESS=1 forces in-process and never touches the worker", async () => {
    const worker: EslintScanWorker = {
      scan: () => Promise.reject(new Error("worker should not be called")),
    };
    const prev = process.env["TEND_ESLINT_INPROCESS"];
    process.env["TEND_ESLINT_INPROCESS"] = "1";
    try {
      const res = await runEslintSonarjs({ cwd: dir, files: ["code.js"], loop: 1 }, worker);
      expect(res.findings.some((f) => f.rule.startsWith("sonarjs/"))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env["TEND_ESLINT_INPROCESS"];
      else process.env["TEND_ESLINT_INPROCESS"] = prev;
    }
  });
});

describe("runEslintSonarjsInProcess — the work the worker runs", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tend-eslint-inproc-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    writeFileSync(join(dir, "code.js"), "export function pick(c) {\n  if (c) { return 42; } else { return 42; }\n}\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("produces sonarjs findings for code that has a smell", async () => {
    const res = await runEslintSonarjsInProcess({ cwd: dir, files: ["code.js"], loop: 1 });
    expect(res.error).toBeUndefined();
    expect(res.findings.some((f) => f.rule.startsWith("sonarjs/"))).toBe(true);
  });

  it("returns a ScanResult rather than throwing when the target cannot be linted", async () => {
    const res = await runEslintSonarjsInProcess({ cwd: join(dir, "does-not-exist"), files: ["x.ts"], loop: 1 });
    expect(res.tool).toBe("sonarjs");
    expect(res.findings).toEqual([]);
  });
});

/**
 * Behaviour of the persistent worker pool, driven against a controllable fixture worker that speaks
 * the same IPC contract. Asserts the OBSERVABLE guarantees — answers scans out-of-process, reuses
 * one warm process, keeps requests separate, surfaces worker errors, recovers from a crash, and is
 * disposed cleanly — without reaching into the pool's internals.
 */
describe("EslintWorker — persistent worker pool", () => {
  const fixtureWorker = fileURLToPath(new URL("./__fixtures__/ipc-test-worker.mjs", import.meta.url));
  type EchoResult = ScanResult & { workerPid?: number; echoedFiles?: string[] };
  /** Build a scan request whose `scanId` tells the fixture worker how to behave. */
  const request = (command: string, files: string[] = ["a.ts"]): ScanContext => ({
    cwd: "/x",
    files,
    loop: 1,
    scanId: command,
  });

  let worker: EslintWorker;
  beforeEach(() => {
    worker = new EslintWorker(fixtureWorker);
  });
  afterEach(() => worker.dispose());

  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("answers a scan from a separate process", async () => {
    const res = (await worker.scan(request("ok"))) as EchoResult;
    expect(res.tool).toBe("sonarjs");
    expect(typeof res.workerPid).toBe("number");
    expect(res.workerPid).not.toBe(process.pid);
  });

  it("returns each request its own result (no cross-talk)", async () => {
    const res = (await worker.scan(request("ok", ["only-this.ts"]))) as EchoResult;
    expect(res.echoedFiles).toEqual(["only-this.ts"]);
  });

  it("reuses one warm process across scans", async () => {
    const first = (await worker.scan(request("ok"))) as EchoResult;
    const second = (await worker.scan(request("ok"))) as EchoResult;
    expect(second.workerPid).toBe(first.workerPid);
  });

  it("answers concurrent scans correctly", async () => {
    const results = (await Promise.all([
      worker.scan(request("slow", ["one.ts"])),
      worker.scan(request("ok", ["two.ts"])),
    ])) as EchoResult[];
    expect(results[0]?.echoedFiles).toEqual(["one.ts"]);
    expect(results[1]?.echoedFiles).toEqual(["two.ts"]);
  });

  it("rejects when the worker reports an error for a scan", async () => {
    await expect(worker.scan(request("error"))).rejects.toThrow("worker boom");
  });

  it("rejects the in-flight scan when the worker crashes, then respawns a fresh process for the next", async () => {
    const before = (await worker.scan(request("ok"))) as EchoResult;
    await expect(worker.scan(request("crash"))).rejects.toThrow();
    const after = (await worker.scan(request("ok"))) as EchoResult;
    expect(after.tool).toBe("sonarjs");
    expect(after.workerPid).not.toBe(before.workerPid); // a new process, not the dead one
  });

  it("dispose() kills the worker process, is idempotent, and a later scan respawns", async () => {
    const pid = ((await worker.scan(request("ok"))) as EchoResult).workerPid!;
    worker.dispose();
    worker.dispose(); // idempotent — must not throw
    for (let i = 0; i < 40 && isAlive(pid); i++) await delay(50);
    expect(isAlive(pid)).toBe(false);

    const after = (await worker.scan(request("ok"))) as EchoResult;
    expect(after.workerPid).not.toBe(pid);
  });
});

describe("disposeEslintWorker (module singleton)", () => {
  it("is safe to call when no worker has been created", () => {
    expect(() => disposeEslintWorker()).not.toThrow();
  });
});

// End-to-end through the PUBLIC api against the real built worker — covers worker resolution, the
// shared singleton, and disposal. Skipped on a source-only run (no dist/), where the other tests
// already cover the in-process fallback.
describe("runEslintSonarjs — real built worker", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tend-eslint-built-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    writeFileSync(join(dir, "code.js"), "export function pick(c) {\n  if (c) { return 42; } else { return 42; }\n}\n");
  });
  afterEach(() => {
    disposeEslintWorker();
    rmSync(dir, { recursive: true, force: true });
  });

  const builtWorker = join(process.cwd(), "dist", "scanners", "eslint-worker.js");
  it.runIf(existsSync(builtWorker))("scans via the real worker process and returns findings", async () => {
    const res = await runEslintSonarjs({ cwd: dir, files: ["code.js"], loop: 1 });
    expect(res.error).toBeUndefined();
    expect(res.findings.some((f) => f.rule.startsWith("sonarjs/"))).toBe(true);
    // Reuse: a second scan goes through the same warm worker and still works.
    const again = await runEslintSonarjs({ cwd: dir, files: ["code.js"], loop: 1 });
    expect(again.findings.some((f) => f.rule.startsWith("sonarjs/"))).toBe(true);
  });
});
