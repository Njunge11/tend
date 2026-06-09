import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

type Exec = (
  file: string,
  args: string[],
  options?: { cwd?: string; reject?: boolean; timeout?: number },
) => Promise<{ stdout?: string; stderr?: string; exitCode?: number | null }>;

const TSC_TIMEOUT_MS = 5 * 60_000;

/**
 * tsc arguments for an incremental, cached `--noEmit` typecheck. **Only** caching/speed
 * flags are added (`--incremental`, `--tsBuildInfoFile`) — never a correctness or
 * tsconfig-semantic flag (`--skipLibCheck`, `--strict`, `--target`, …). The owning
 * package's tsconfig is still resolved from the cwd, so its semantics are unchanged.
 */
export function incrementalTscArgs(cacheFile: string): string[] {
  return ["tsc", "--noEmit", "--incremental", "--tsBuildInfoFile", cacheFile];
}

/**
 * A stable, tend-owned build-info cache path for the package rooted at `ownerRoot`.
 *
 * The caller roots `cacheDir` at the **main** repo's `.tend/cache` — outside any sandbox
 * worktree — so the file survives `reset()`/`git clean` between iterations and is reused.
 * The filename encodes the owner's repo-relative path (slug + hash) so monorepo packages
 * get distinct caches that don't collide.
 */
export function tscCacheFile(cacheDir: string, mainRoot: string, ownerRoot: string): string {
  const rel = relative(mainRoot, ownerRoot).replaceAll("\\", "/") || ".";
  const slug = rel === "." ? "root" : rel.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+/, "").replace(/-+$/, "") || "pkg";
  const hash = createHash("sha256").update(rel).digest("hex").slice(0, 8);
  return join(cacheDir, `${slug}-${hash}.tsbuildinfo`);
}

type IncrementalTscDeps = {
  /** Command runner (execa-compatible). */
  exec: Exec;
  /** The owning package root tsc runs in (its tsconfig is resolved from here). */
  cwd: string;
  /** Absolute build-info cache path, outside the worktree (see {@link tscCacheFile}). */
  cacheFile: string;
  timeoutMs?: number;
};

/**
 * Run `tsc --noEmit` with an incremental cache. Ensures the cache directory exists, then
 * runs tsc. tsc itself tolerates a missing or corrupt build-info file (it rebuilds from
 * scratch and overwrites), so correctness is unaffected — only cold runs are slower.
 */
export async function runIncrementalTsc(
  deps: IncrementalTscDeps,
): Promise<{ exitCode: number; output: string }> {
  mkdirSync(dirname(deps.cacheFile), { recursive: true });
  const r = await deps.exec("npx", incrementalTscArgs(deps.cacheFile), {
    cwd: deps.cwd,
    reject: false,
    timeout: deps.timeoutMs ?? TSC_TIMEOUT_MS,
  });
  // exitCode is undefined on timeout/spawn failure → treat as a typecheck failure (revert).
  return {
    exitCode: r.exitCode ?? 1,
    output: `${r.stdout ?? ""}\n${r.stderr ?? ""}`,
  };
}
