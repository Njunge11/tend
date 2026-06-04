import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SimpleGit } from "simple-git";
import { createGit } from "./client.js";

const SNAP_MSG = "tend snapshot";
/** A private ref pins the snapshot commit so `git gc` can't prune it (it's on no branch). */
const SNAP_REF = "refs/tend/snapshot";

let indexCounter = 0;

/**
 * Write the entire current working tree (tracked + untracked, honoring .gitignore) into a git
 * tree object, using a throwaway index so the user's real staging area is never touched.
 * Returns the tree's object id. Git stores only new blobs and reuses the rest — near-instant,
 * a few KB, not a full copy of every file.
 */
async function writeWorkingTree(root: string): Promise<string> {
  const idxPath = join(tmpdir(), `tend-index-${process.pid}-${indexCounter++}`);
  try {
    const g = createGit(root, { GIT_INDEX_FILE: idxPath });
    await g.raw(["add", "-A"]); // stage everything present; respects .gitignore (and .tend/, excluded below)
    return (await g.raw(["write-tree"])).trim();
  } finally {
    rmSync(idxPath, { force: true });
  }
}

/** Keep tend's own `.tend/` artifacts out of snapshots and the user's `git status`. */
function ensureTendIgnored(gitDir: string): void {
  const excludePath = join(gitDir, "info", "exclude");
  const line = ".tend/";
  let current = "";
  try {
    current = readFileSync(excludePath, "utf8");
  } catch {
    /* no exclude file yet */
  }
  if (current.split("\n").some((l) => l.trim() === line)) return;
  mkdirSync(dirname(excludePath), { recursive: true });
  const sep = current === "" || current.endsWith("\n") ? "" : "\n";
  writeFileSync(excludePath, `${current}${sep}${line}\n`);
}

const lines = (raw: string): string[] => raw.split("\n").map((l) => l.trim()).filter(Boolean);

/** Files currently in the repo: tracked + untracked (non-ignored), repo-root-relative. */
async function currentFiles(root: string): Promise<string[]> {
  const g = createGit(root);
  const tracked = await g.raw(["ls-files"]);
  const untracked = await g.raw(["ls-files", "--others", "--exclude-standard"]);
  return [...new Set([...lines(tracked), ...lines(untracked)])];
}

/**
 * A silent restore point for the working tree, stored as a git commit object pinned by a private
 * ref (`refs/tend/snapshot`) — nothing committed to any branch, the editor sees no change. Backs
 * `tend undo` (exact restore) and `tend diff` (only the tool's edits). Reuses git's content store,
 * so the on-disk record is a 40-char id rather than a copy of every file.
 */
export class Snapshot {
  private constructor(
    private readonly cwd: string,
    private readonly root: string,
    private readonly sha: string,
  ) {}

  static async capture(_git: SimpleGit, cwd: string): Promise<Snapshot> {
    const git = createGit(cwd);
    const root = (await git.revparse(["--show-toplevel"])).trim();
    const gitDir = (await git.revparse(["--absolute-git-dir"])).trim();
    ensureTendIgnored(gitDir);

    const rg = createGit(root);
    const tree = await writeWorkingTree(root);
    // Parent the snapshot on HEAD when there is one (nicer `git diff`); tolerate a repo with no commits.
    let parent: string | null = null;
    try {
      parent = (await rg.revparse(["HEAD"])).trim();
    } catch {
      parent = null;
    }
    const commitArgs = parent
      ? ["commit-tree", tree, "-p", parent, "-m", SNAP_MSG]
      : ["commit-tree", tree, "-m", SNAP_MSG];
    const sha = (await rg.raw(commitArgs)).trim();
    await rg.raw(["update-ref", SNAP_REF, sha]);
    return new Snapshot(cwd, root, sha);
  }

  /** Serialize to a tiny object for `.tend/snapshot.json` (powers `undo` across invocations). */
  toJSON(): { cwd: string; root: string; sha: string } {
    return { cwd: this.cwd, root: this.root, sha: this.sha };
  }

  static fromJSON(data: { cwd: string; root: string; sha: string }): Snapshot {
    return new Snapshot(data.cwd, data.root, data.sha);
  }

  /** Files whose contents differ from the snapshot, or that are new/deleted since it (sorted). */
  async changedSince(_git: SimpleGit): Promise<string[]> {
    const currentTree = await writeWorkingTree(this.root);
    const diff = await createGit(this.root).raw(["diff", "--name-only", this.sha, currentTree]);
    return lines(diff).sort();
  }

  /** Restore a single file to its captured contents (worktree only — the user's index is untouched). */
  async restoreFile(rel: string): Promise<void> {
    await createGit(this.root).raw(["restore", "--source", this.sha, "--worktree", "--", rel]);
  }

  /** Restore the working tree exactly to the captured state (incl. deleting files created since). */
  async restore(_git: SimpleGit): Promise<void> {
    const rg = createGit(this.root);
    // Rewrite every captured path back into the working tree; --worktree leaves the index alone.
    await rg.raw(["restore", "--source", this.sha, "--worktree", "--", ":/"]);
    // Remove files that exist now but weren't in the snapshot (e.g. files the tool created).
    const inSnapshot = new Set(lines(await rg.raw(["ls-tree", "-r", "--name-only", this.sha])));
    for (const rel of await currentFiles(this.root)) {
      if (!inSnapshot.has(rel)) rmSync(join(this.root, rel), { force: true });
    }
  }
}
