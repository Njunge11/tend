import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { execa } from "execa";
import type { Spawn, Which } from "./scanner.js";

/** Scanner binary name → the npm package tend bundles for it. */
const BUNDLED_PACKAGE: Record<string, string> = {
  eslint: "eslint",
  knip: "knip",
  jscpd: "jscpd",
};

/**
 * Resolve a bin script from a package.json at `pkgDir`.
 * When `expectedName` is supplied, skips the directory if the package name does not match —
 * used by resolveBinFrom when walking up from an entry-point to find the owning package root.
 */
function binScriptIn(pkgDir: string, binary: string, expectedName?: string): string | null {
  const pkgJson = join(pkgDir, "package.json");
  if (!existsSync(pkgJson)) return null;
  try {
    const json = JSON.parse(readFileSync(pkgJson, "utf8")) as { name?: string; bin?: string | Record<string, string> };
    if (expectedName && json.name !== expectedName) return null;
    const rel = typeof json.bin === "string" ? json.bin : json.bin?.[binary];
    if (!rel) return null;
    const script = join(pkgDir, rel);
    return existsSync(script) ? script : null;
  } catch {
    return null;
  }
}

/** Find a package's bin script via a given resolver base, robust to `exports` hiding package.json. */
function resolveBinFrom(base: string, pkg: string, binary: string): string | null {
  try {
    const req = createRequire(base);
    let dir = dirname(req.resolve(pkg));
    for (let i = 0; i < 8; i++) {
      const found = binScriptIn(dir, binary, pkg);
      if (found) return found;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* not resolvable from this base */
  }
  return null;
}

/** A scanner's bin resolved from tend's own dependencies (always present for bundled tools). */
export function resolveBundledScanner(binary: string): string | null {
  const pkg = BUNDLED_PACKAGE[binary];
  return pkg ? resolveBinFrom(import.meta.url, pkg, binary) : null;
}

/**
 * A scanner's bin resolved strictly from the TARGET PROJECT's node_modules (walking up
 * workspace roots), if it ships its own copy. No fallback to cwd/global — so an unrelated
 * install never leaks in. Returns null when the project doesn't have its own copy.
 */
export function resolveProjectScanner(binary: string, cwd: string): string | null {
  const pkg = BUNDLED_PACKAGE[binary];
  if (!pkg) return null;
  let dir = cwd;
  for (let i = 0; i < 12; i++) {
    const found = binScriptIn(join(dir, "node_modules", pkg), binary);
    if (found) return found;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function onPath(binary: string): Promise<boolean> {
  const finder = process.platform === "win32" ? "where" : "which";
  const result = await execa(finder, [binary], { reject: false });
  return result.exitCode === 0;
}

/** Available if tend bundles it, or it's on PATH. */
export const realWhich: Which = async (binary) => {
  if (resolveBundledScanner(binary)) return true;
  return onPath(binary);
};

/**
 * Run a scanner. For the npm-based tools, prefer the PROJECT's own installed version (respects
 * their pinned version + config), falling back to tend's bundled copy; run either via node.
 * Native tools fall back to the PATH binary. Never rejects on non-zero exit.
 */
export const realSpawn: Spawn = async (binary, args, opts) => {
  const resolved = resolveProjectScanner(binary, opts.cwd) ?? resolveBundledScanner(binary);
  const [cmd, cmdArgs] = resolved ? [process.execPath, [resolved, ...args]] : [binary, args];

  const result = await execa(cmd, cmdArgs, {
    cwd: opts.cwd,
    timeout: opts.timeout,
    reject: false,
    all: false,
  });
  if (result.timedOut) throw new Error(`${binary} timed out after ${opts.timeout}ms`);
  return {
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    exitCode: result.exitCode ?? 0,
  };
};
