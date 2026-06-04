import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

type TestRunner = "vitest" | "jest";

const CONFIG_GLOBS: Record<TestRunner, string[]> = {
  vitest: ["vitest.config.ts", "vitest.config.js", "vitest.config.mjs", "vitest.config.mts"],
  jest: ["jest.config.ts", "jest.config.js", "jest.config.mjs", "jest.config.cjs", "jest.config.json"],
};

function dependsOn(cwd: string, pkg: string): boolean {
  const pkgJsonPath = join(cwd, "package.json");
  if (!existsSync(pkgJsonPath)) return false;
  try {
    const json = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return Boolean(json.dependencies?.[pkg] ?? json.devDependencies?.[pkg]);
  } catch {
    return false;
  }
}

const hasConfig = (cwd: string, runner: TestRunner): boolean =>
  CONFIG_GLOBS[runner].some((f) => existsSync(join(cwd, f)));

/** cwd and each ancestor directory up to (and including) the filesystem root. */
function ancestors(cwd: string): string[] {
  const dirs: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    dirs.push(dir);
    if (dirname(dir) === dir) return dirs;
  }
}

/**
 * Detect the test runner from config files + package.json deps; `undefined` if none.
 * Walks up the directory tree so it still resolves when run from a nested directory
 * inside a workspace (the config/deps usually live at the package root, not the cwd).
 */
export function detectTestRunner(cwd: string): TestRunner | undefined {
  for (const dir of ancestors(cwd)) {
    for (const runner of ["vitest", "jest"] as const) {
      if (hasConfig(dir, runner) || dependsOn(dir, runner)) return runner;
    }
  }
  return undefined;
}
