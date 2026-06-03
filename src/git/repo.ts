import type { SimpleGit } from "simple-git";
import type { Snapshot } from "./snapshot.js";

/** Refuse to run outside a git repo — the snapshot/restore safety net needs it. */
export async function assertGitRepo(git: SimpleGit): Promise<void> {
  if (!(await git.checkIsRepo())) {
    throw new Error("not a git repository — run tend inside a git repo");
  }
}

/**
 * `git status` reports paths relative to the repo root and for the whole repo, even
 * when run from a subdirectory. Scanners run from `git`'s working dir and report paths
 * relative to it, so we scope changed files to that subtree and re-base them onto it
 * using git's own cwd→root prefix (empty when run from the repo root).
 */
function scopeToCwd(repoPath: string, prefix: string): string | null {
  if (!prefix) return repoPath; // running at the repo root: paths already match
  if (!repoPath.startsWith(prefix)) return null; // outside the working subtree
  return repoPath.slice(prefix.length);
}

/**
 * Files changed vs `HEAD`: tracked modifications/additions/renames plus untracked files,
 * scoped and re-based to `git`'s working directory (so a run from `apps/foo` only sees
 * `apps/foo`'s changes, pathed as the scanners path them).
 */
export async function changedVsHead(git: SimpleGit): Promise<string[]> {
  const prefix = (await git.revparse(["--show-prefix"])).trim();
  const status = await git.status();
  const files = new Set<string>();
  for (const file of status.files) {
    const repoPath = file.path.includes(" -> ") ? file.path.split(" -> ")[1]! : file.path;
    const rel = scopeToCwd(repoPath, prefix);
    if (rel !== null) files.add(rel);
  }
  return [...files];
}

/** Revert a single file to its snapshot state. */
export function revertFile(snapshot: Snapshot, file: string): Promise<void> {
  return snapshot.restoreFile(file);
}
