import type { SimpleGit } from "simple-git";
import type { Finding } from "../findings/finding.js";

/**
 * Files changed vs `HEAD` (tracked modifications/additions/renames plus untracked),
 * scoped and re-based to `git`'s working directory — see `changedVsHead` in git/repo.ts
 * for why this matters when tend runs from a subdirectory of the repo.
 */
export async function changedFiles(git: SimpleGit): Promise<string[]> {
  const prefix = (await git.revparse(["--show-prefix"])).trim();
  const status = await git.status();
  const files = new Set<string>();
  for (const file of status.files) {
    // simple-git reports renames as "old -> new"; keep the new path
    const path = file.path.includes(" -> ") ? file.path.split(" -> ")[1]! : file.path;
    if (!prefix) {
      files.add(path);
    } else if (path.startsWith(prefix)) {
      files.add(path.slice(prefix.length));
    }
  }
  return [...files];
}

/** Keep only findings whose file is in the changed set. */
export function filterToChanged(findings: Finding[], changed: string[]): Finding[] {
  const set = new Set(changed);
  return findings.filter((f) => {
    if (set.has(f.file)) return true;
    // A duplication finding pairs two files but records only the first as `.file`. Keep the
    // clone when EITHER side changed — both sites are carried on `flowPath`.
    if (f.category === "duplication") return (f.flowPath ?? []).some((p) => set.has(p.file));
    return false;
  });
}

/** Apply the fix scope: `--all` fixes everything, otherwise only changed files. */
export function scopeFindings(
  findings: Finding[],
  opts: { all: boolean; changed: string[] },
): Finding[] {
  return opts.all ? findings : filterToChanged(findings, opts.changed);
}
