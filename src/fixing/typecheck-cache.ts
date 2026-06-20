import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
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
  const slug = rel === "." ? "root" : slugifyRelPath(rel);
  const hash = createHash("sha256").update(rel).digest("hex").slice(0, 8);
  return join(cacheDir, `${slug}-${hash}.tsbuildinfo`);
}

/**
 * Turn a repo-relative path into a filesystem-safe slug: runs of non-alphanumerics
 * collapse to a single "-", with leading/trailing dashes trimmed. The trim scans the
 * string instead of using `^-+`/`-+$` regexes, so the whole computation is provably
 * linear with no polynomial backtracking on adversarial input (SonarQube S5852).
 */
function slugifyRelPath(rel: string): string {
  const collapsed = rel.replace(/[^a-zA-Z0-9]+/g, "-");
  let start = 0;
  let end = collapsed.length;
  while (start < end && collapsed[start] === "-") start += 1;
  while (end > start && collapsed[end - 1] === "-") end -= 1;
  return collapsed.slice(start, end) || "pkg";
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
 * Resolve the project's REAL TypeScript compiler entry (`typescript/bin/tsc`) from `cwd`, or
 * null when TypeScript isn't installed there. Running this directly with `node` instead of
 * `npx tsc` matters: when `npx` can't find a local `tsc` it silently runs a registry package
 * literally named `tsc` (a decoy that prints "This is not the tsc command you are looking for"
 * and exits non-zero) — which the gate reads as a typecheck failure and reverts the fix. Direct
 * resolution can never hit that decoy.
 */
function resolveTscBin(cwd: string): string | null {
  try {
    return createRequire(join(cwd, "noop.js")).resolve("typescript/bin/tsc");
  } catch {
    return null;
  }
}

/**
 * Run `tsc --noEmit` with an incremental cache. Ensures the cache directory exists, then
 * runs tsc. tsc itself tolerates a missing or corrupt build-info file (it rebuilds from
 * scratch and overwrites), so correctness is unaffected — only cold runs are slower.
 *
 * Prefers the project's resolved `typescript` binary run via `node`; only when TypeScript can't
 * be resolved does it fall back to `npx --no-install tsc` (which at least never *installs* the
 * decoy). See {@link resolveTscBin}.
 */
export async function runIncrementalTsc(
  deps: IncrementalTscDeps,
): Promise<{ exitCode: number; output: string }> {
  mkdirSync(dirname(deps.cacheFile), { recursive: true });
  const baseArgs = incrementalTscArgs(deps.cacheFile); // ["tsc", "--noEmit", "--incremental", ...]
  const tscBin = resolveTscBin(deps.cwd);
  const [file, args]: [string, string[]] = tscBin
    ? [process.execPath, [tscBin, ...baseArgs.slice(1)]]
    : ["npx", ["--no-install", ...baseArgs]];
  const r = await deps.exec(file, args, {
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
