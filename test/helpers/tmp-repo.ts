import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SimpleGit } from "simple-git";
import { createGit } from "../../src/git/client.js";

export type TmpRepo = {
  dir: string;
  git: SimpleGit;
  /** Write a file (creating parent dirs) relative to the repo root. */
  write(relPath: string, contents: string): void;
  /** Stage everything and commit. */
  commit(message: string): Promise<void>;
  cleanup(): void;
};

/** Create a throwaway git repo in a temp dir for git-dependent tests. */
export async function tmpRepo(): Promise<TmpRepo> {
  const dir = mkdtempSync(join(tmpdir(), "tend-repo-"));
  const git = createGit(dir);
  await git.init();
  await git.addConfig("user.email", "test@tend.dev");
  await git.addConfig("user.name", "tend test");
  await git.addConfig("commit.gpgsign", "false");

  const write = (relPath: string, contents: string): void => {
    const abs = join(dir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  };

  const commit = async (message: string): Promise<void> => {
    await git.add(".");
    await git.commit(message);
  };

  return { dir, git, write, commit, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
