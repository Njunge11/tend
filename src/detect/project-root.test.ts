import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectTestRunner } from "./test-runner.js";
import { detectTypeScript } from "./typescript.js";
import { resolveOwnerRoot, toOwnerRelative } from "./project-root.js";

// A monorepo with one workspace package that owns the test/TS config:
//   root/package.json + pnpm-lock.yaml        (workspace root, no tsconfig/runner)
//   root/apps/dashboard/package.json
//   root/apps/dashboard/tsconfig.json
//   root/apps/dashboard/vitest.config.mts
//   root/apps/dashboard/src/a.ts
let root: string;
let dashboard: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tend-owner-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "monorepo" }));
  writeFileSync(join(root, "pnpm-lock.yaml"), "");

  dashboard = join(root, "apps", "dashboard");
  mkdirSync(join(dashboard, "src"), { recursive: true });
  writeFileSync(join(dashboard, "package.json"), JSON.stringify({ devDependencies: { vitest: "^3.0.0" } }));
  writeFileSync(join(dashboard, "tsconfig.json"), "{}");
  writeFileSync(join(dashboard, "vitest.config.mts"), "export default {};");
  writeFileSync(join(dashboard, "src", "a.ts"), "export const a = 1;");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("resolveOwnerRoot", () => {
  it("resolves to the owning package for files under a nested workspace", () => {
    expect(resolveOwnerRoot(root, ["apps/dashboard/src/a.ts"])).toBe(dashboard);
  });

  it("resolves to the owning package for a directory-scoped expansion", () => {
    // Multiple files that all live under apps/dashboard share one owner root.
    expect(
      resolveOwnerRoot(root, [
        "apps/dashboard/src/a.ts",
        "apps/dashboard/src/b.ts",
        "apps/dashboard/vitest.config.mts",
      ]),
    ).toBe(dashboard);
  });

  it("falls back to the repo cwd when no nested package owns the file", () => {
    writeFileSync(join(root, "root-file.ts"), "export const x = 1;");
    expect(resolveOwnerRoot(root, ["root-file.ts"])).toBe(root);
  });

  it("is not fragmented by a nested package.json below the scope", () => {
    // packages/tend owns the scope, but it contains a test fixture with its own
    // package.json. Resolving from the common ancestor keeps the owner at packages/tend
    // instead of falling back to the repo root — this is the `tend run packages/tend` bug.
    const tend = join(root, "packages", "tend");
    mkdirSync(join(tend, "src"), { recursive: true });
    mkdirSync(join(tend, "test", "fixtures", "monorepo"), { recursive: true });
    writeFileSync(join(tend, "package.json"), JSON.stringify({ name: "tend-cli" }));
    writeFileSync(join(tend, "tsconfig.json"), "{}");
    writeFileSync(join(tend, "vitest.config.mts"), "export default {};");
    writeFileSync(join(tend, "test", "fixtures", "monorepo", "package.json"), JSON.stringify({ name: "fixture" }));

    const owner = resolveOwnerRoot(root, [
      "packages/tend/package.json",
      "packages/tend/src/a.ts",
      "packages/tend/test/fixtures/monorepo/package.json",
    ]);
    expect(owner).toBe(tend);
    expect(detectTypeScript(owner)).toBe(true);
    expect(detectTestRunner(owner)).toBe("vitest");
  });

  it("falls back to the repo cwd when files span multiple packages", () => {
    const jobBoard = join(root, "apps", "job-board");
    mkdirSync(join(jobBoard, "src"), { recursive: true });
    writeFileSync(join(jobBoard, "package.json"), JSON.stringify({ name: "job-board" }));
    writeFileSync(join(jobBoard, "src", "c.ts"), "export const c = 1;");

    expect(
      resolveOwnerRoot(root, ["apps/dashboard/src/a.ts", "apps/job-board/src/c.ts"]),
    ).toBe(root);
  });

  it("falls back to the repo cwd for an empty scope", () => {
    expect(resolveOwnerRoot(root, [])).toBe(root);
  });

  it("detects TypeScript and vitest from the resolved owner root", () => {
    const owner = resolveOwnerRoot(root, ["apps/dashboard/src/a.ts"]);
    expect(detectTypeScript(owner)).toBe(true);
    expect(detectTestRunner(owner)).toBe("vitest");

    // Detecting from the repo root instead would miss both — that's the bug this fixes.
    expect(detectTypeScript(root)).toBe(false);
    expect(detectTestRunner(root)).toBeUndefined();
  });

  it("falls back to a tsconfig project root when no package.json exists up to cwd", () => {
    // A repo with no package.json anywhere up to cwd, but a nested dir carries its own
    // tsconfig — the project-root-signal fallback recognizes it as the owner root.
    const bare = mkdtempSync(join(tmpdir(), "tend-bare-"));
    try {
      const lib = join(bare, "lib");
      mkdirSync(lib, { recursive: true });
      writeFileSync(join(lib, "tsconfig.json"), "{}");
      writeFileSync(join(lib, "x.ts"), "export const x = 1;");

      expect(resolveOwnerRoot(bare, ["lib/x.ts"])).toBe(lib);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("prefers the nearest package.json over a deeper config-only directory", () => {
    // apps/dashboard has package.json; a deeper src dir carries only a tsconfig. The
    // package.json boundary wins so detection/gating run against the whole package.
    writeFileSync(join(dashboard, "src", "tsconfig.json"), "{}");
    expect(resolveOwnerRoot(root, ["apps/dashboard/src/a.ts"])).toBe(dashboard);
  });

  it("resolves the retry target's owner root from its code + sibling test files", () => {
    // planWork bundles a code file with its sibling test; both live under the package.
    const unitFiles = ["apps/dashboard/src/a.ts", "apps/dashboard/src/a.test.ts"];
    expect(resolveOwnerRoot(root, unitFiles)).toBe(dashboard);
  });
});

describe("toOwnerRelative", () => {
  it("re-bases repo-relative files onto the owner root", () => {
    expect(
      toOwnerRelative(["apps/dashboard/src/a.ts", "apps/dashboard/src/a.test.ts"], root, dashboard),
    ).toStrictEqual(["src/a.ts", "src/a.test.ts"]);
  });

  it("is identity when the owner root is the repo cwd", () => {
    expect(toOwnerRelative(["src/a.ts"], root, root)).toStrictEqual(["src/a.ts"]);
  });
});
