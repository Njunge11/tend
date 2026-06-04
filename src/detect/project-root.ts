import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const PACKAGE_JSON = "package.json";

// Project-root signals beyond package.json — a directory carrying its own TypeScript,
// test-runner, or ESLint config is a package boundary too. Consulted only as a fallback
// when no package.json exists up to the repo root, so the common monorepo layout (every
// package has a package.json) keeps resolving to the nearest package.json.
const PROJECT_ROOT_MARKERS = [
  "tsconfig.json",
  "vitest.config.ts",
  "vitest.config.js",
  "vitest.config.mjs",
  "vitest.config.mts",
  "jest.config.ts",
  "jest.config.js",
  "jest.config.mjs",
  "jest.config.cjs",
  "jest.config.json",
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "eslint.config.mts",
  "eslint.config.cts",
];

/**
 * Nearest directory at or above `from` (bounded by `stopAt`, inclusive) that holds any of
 * `markers`. Returns `null` when none is found before reaching `stopAt` or the filesystem
 * root — never walks above `stopAt` (the repo root we were invoked from).
 */
function nearestWithMarker(from: string, stopAt: string, markers: string[]): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    if (markers.some((m) => existsSync(join(dir, m)))) return dir;
    if (dir === stopAt) return null;
    const parent = dirname(dir);
    if (parent === dir) return null; // hit the filesystem root before stopAt
  }
}

/**
 * The package/project root owning `from`: the nearest ancestor with a package.json, or —
 * only when none exists up to `stopAt` — the nearest ancestor carrying a tsconfig/test/lint
 * config. `null` when neither is found.
 */
function nearestOwnerRoot(from: string, stopAt: string): string | null {
  return (
    nearestWithMarker(from, stopAt, [PACKAGE_JSON]) ??
    nearestWithMarker(from, stopAt, PROJECT_ROOT_MARKERS)
  );
}

/** Deepest directory that is an ancestor of every path in `absDirs` (all absolute). */
function commonAncestorDir(absDirs: string[]): string {
  let parts = absDirs[0]!.split(sep);
  for (const dir of absDirs.slice(1)) {
    const other = dir.split(sep);
    let i = 0;
    while (i < parts.length && i < other.length && parts[i] === other[i]) i++;
    parts = parts.slice(0, i);
  }
  return parts.join(sep) || sep;
}

/**
 * Resolve the package root that owns the scoped files, for stack detection and gate
 * execution. Takes the common ancestor directory of the scoped files and walks up from
 * there to the nearest package/project root (a package.json, or failing that a
 * tsconfig/test/lint config), bounded by `cwd` (the repo root tend was invoked from).
 *
 * Using the common ancestor — rather than resolving each file independently — means
 * nested packages *below* the scope (e.g. test fixtures with their own package.json under
 * `packages/tend/test/fixtures/`) don't fragment the result: a `tend run packages/tend`
 * still resolves to `packages/tend`. A scope that genuinely straddles sibling packages
 * has a common ancestor above any one package, so it falls back to `cwd` — the
 * conservative repo-root behavior. Empty scope also falls back to `cwd`.
 *
 * `files` must be concrete repo-relative paths (not `.`); callers pass `cwd` directly
 * for whole-repo runs rather than routing through here.
 */
export function resolveOwnerRoot(cwd: string, files: string[]): string {
  if (files.length === 0) return cwd;
  const dirs = files.map((file) => dirname(resolve(cwd, file)));
  return nearestOwnerRoot(commonAncestorDir(dirs), cwd) ?? cwd;
}

/**
 * Re-base repo-relative file paths onto `ownerRoot` so a test runner invoked with its
 * cwd set to the owning package receives paths it can resolve. Identity when the owner
 * root is the repo root (`cwd`), so whole-repo and single-package-at-root runs are
 * unchanged.
 */
export function toOwnerRelative(files: string[], cwd: string, ownerRoot: string): string[] {
  if (ownerRoot === cwd) return files;
  return files.map((file) => relative(ownerRoot, resolve(cwd, file)) || ".");
}
