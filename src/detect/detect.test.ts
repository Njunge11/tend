import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectPackageManager } from "./package-manager.js";
import { detectTestRunner } from "./test-runner.js";
import { detectTypeScript } from "./typescript.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tend-detect-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const touch = (name: string, contents = "") => writeFileSync(join(dir, name), contents);
const pkg = (obj: unknown) => writeFileSync(join(dir, "package.json"), JSON.stringify(obj));

describe("detectPackageManager", () => {
  it("T-085: detect package manager from lockfile (pnpm/npm/yarn/bun)", () => {
    touch("pnpm-lock.yaml");
    expect(detectPackageManager(dir)).toBe("pnpm");
    rmSync(join(dir, "pnpm-lock.yaml"));

    touch("yarn.lock");
    expect(detectPackageManager(dir)).toBe("yarn");
    rmSync(join(dir, "yarn.lock"));

    touch("bun.lockb");
    expect(detectPackageManager(dir)).toBe("bun");
    rmSync(join(dir, "bun.lockb"));

    touch("package-lock.json");
    expect(detectPackageManager(dir)).toBe("npm");
  });
});

describe("detectTypeScript", () => {
  it("T-086: detect TypeScript via tsconfig", () => {
    touch("tsconfig.json", "{}");
    expect(detectTypeScript(dir)).toBe(true);
  });

  it("T-089: no tsconfig → JS mode", () => {
    expect(detectTypeScript(dir)).toBe(false);
  });
});

describe("detectTestRunner", () => {
  it("T-087: detect test runner (vitest/jest) from config + package.json", () => {
    pkg({ devDependencies: { vitest: "^3.0.0" } });
    expect(detectTestRunner(dir)).toBe("vitest");

    rmSync(join(dir, "package.json"));
    touch("jest.config.js", "module.exports = {};");
    expect(detectTestRunner(dir)).toBe("jest");
  });

  it("T-088: no test runner detected → none", () => {
    pkg({ dependencies: { react: "^19.0.0" } });
    expect(detectTestRunner(dir)).toBeUndefined();
  });

  it("T-088b: resolves a runner in an ancestor when run from a nested directory", () => {
    // workspace root holds the vitest config; tend is run from a deep subdir
    touch("vitest.config.ts", "export default {};");
    const nested = join(dir, "apps", "dashboard", "app");
    mkdirSync(nested, { recursive: true });
    expect(detectTestRunner(nested)).toBe("vitest");
  });
});
