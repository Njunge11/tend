import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/** Walk up from this module to tend's own package root (dir of its package.json named tend-cli). */
function tendPackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const pkgJson = join(dir, "package.json");
    if (existsSync(pkgJson)) {
      try {
        if ((JSON.parse(readFileSync(pkgJson, "utf8")) as { name?: string }).name === "tend-cli") {
          return dir;
        }
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/** Absolute path to tend's bundled default config (eslint recommended + sonarjs). */
export function defaultEslintConfigPath(): string {
  return join(tendPackageRoot(), "configs", "default.eslint.config.mjs");
}

const ESLINT_CONFIG_FILES = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "eslint.config.mts",
  "eslint.config.cts",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.yaml",
  ".eslintrc.yml",
  ".eslintrc.json",
  ".eslintrc",
];

function readPackageJson(cwd: string): Record<string, unknown> | null {
  const p = join(cwd, "package.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Does the project have any eslint config (a config file, or an `eslintConfig` key in package.json)? */
export function projectHasEslintConfig(cwd: string): boolean {
  if (ESLINT_CONFIG_FILES.some((name) => existsSync(join(cwd, name)))) return true;
  return Boolean(readPackageJson(cwd)?.["eslintConfig"]);
}

/**
 * Nearest directory at or above `startDir`, up to and including `boundaryDir`, that holds an
 * eslint config — or null if none. Lets tend resolve each scoped file's governing config by
 * walking upward from the file, so a monorepo package keeps its own config even when tend is
 * invoked from the repo root (where there may be no config at all).
 */
export function findEslintConfigDir(startDir: string, boundaryDir: string): string | null {
  const boundary = resolve(boundaryDir);
  let dir = resolve(startDir);
  for (;;) {
    if (projectHasEslintConfig(dir)) return dir;
    if (dir === boundary) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function dependsOnSonarjs(cwd: string): boolean {
  const pkg = readPackageJson(cwd);
  if (!pkg) return false;
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = pkg[field] as Record<string, string> | undefined;
    if (deps?.["eslint-plugin-sonarjs"]) return true;
  }
  return false;
}

function configMentionsSonarjs(cwd: string): boolean {
  for (const name of ESLINT_CONFIG_FILES) {
    const p = join(cwd, name);
    if (existsSync(p)) {
      try {
        if (readFileSync(p, "utf8").includes("sonarjs")) return true;
      } catch {
        /* ignore */
      }
    }
  }
  const eslintConfig = readPackageJson(cwd)?.["eslintConfig"];
  return eslintConfig ? JSON.stringify(eslintConfig).includes("sonarjs") : false;
}

/** Project configures sonarjs = plugin is a dependency AND a config references it. */
export function projectConfiguresSonarjs(cwd: string): boolean {
  return dependsOnSonarjs(cwd) && configMentionsSonarjs(cwd);
}

export type EslintMode = "default" | "layer" | "defer";

/**
 * How tend should run eslint+sonarjs for a project:
 *  - `default` — no project eslint config → use tend's config (eslint recommended + sonarjs)
 *  - `layer`   — project eslint config without sonarjs → use theirs + sonarjs layered on top
 *  - `defer`   — project eslint config already includes sonarjs → use theirs untouched
 */
export function eslintMode(cwd: string): EslintMode {
  if (!projectHasEslintConfig(cwd)) return "default";
  return projectConfiguresSonarjs(cwd) ? "defer" : "layer";
}
