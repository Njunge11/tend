import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tmpRepo, type TmpRepo } from "../../test/helpers/tmp-repo.js";
import { createGit } from "./client.js";
import { Snapshot } from "./snapshot.js";

let repo: TmpRepo;
beforeEach(async () => {
  repo = await tmpRepo();
});
afterEach(() => repo.cleanup());

const read = (p: string) => readFileSync(join(repo.dir, p), "utf8");
const write = (p: string, c: string) => writeFileSync(join(repo.dir, p), c);
const lines = (raw: string) => raw.split("\n").map((l) => l.trim()).filter(Boolean);
const staged = async () => lines(await repo.git.raw(["diff", "--cached", "--name-only"]));
const unstaged = async () => lines(await repo.git.raw(["diff", "--name-only"]));
const porcelain = async () => lines(await repo.git.raw(["status", "--porcelain"]));

describe("Snapshot", () => {
  it("T-078 / T-081: capture includes tracked + untracked files", async () => {
    repo.write("src/tracked.ts", "TRACKED\n");
    await repo.commit("init");
    repo.write("src/untracked.ts", "UNTRACKED\n"); // never committed

    const snap = await Snapshot.capture(repo.git, repo.dir);
    // mutate both, then restore
    write("src/tracked.ts", "CHANGED\n");
    write("src/untracked.ts", "CHANGED\n");

    await snap.restore(repo.git);

    expect(read("src/tracked.ts")).toBe("TRACKED\n");
    expect(read("src/untracked.ts")).toBe("UNTRACKED\n"); // untracked restored too
  });

  it("T-079: restore returns the working tree to the captured state (incl. deleting new files)", async () => {
    repo.write("src/a.ts", "A\n");
    await repo.commit("init");

    const snap = await Snapshot.capture(repo.git, repo.dir);
    write("src/a.ts", "MODIFIED\n");
    write("src/new.ts", "NEW\n"); // created after snapshot

    await snap.restore(repo.git);

    expect(read("src/a.ts")).toBe("A\n");
    expect(existsSync(join(repo.dir, "src/new.ts"))).toBe(false);
  });

  it("T-081b: snapshot survives git gc --prune=now (pinned by a ref, not a loose object)", async () => {
    repo.write("src/a.ts", "ORIGINAL\n");
    await repo.commit("init");
    repo.write("src/untracked.ts", "WIP\n"); // uncommitted work — only recoverable via the snapshot

    const snap = await Snapshot.capture(repo.git, repo.dir);
    write("src/a.ts", "MANGLED\n");
    write("src/created.ts", "tool made this\n");

    // Aggressively prune unreachable objects — would delete a loose/dangling snapshot commit.
    await repo.git.raw(["gc", "--prune=now"]);

    await snap.restore(repo.git);

    expect(read("src/a.ts")).toBe("ORIGINAL\n");
    expect(read("src/untracked.ts")).toBe("WIP\n");
    expect(existsSync(join(repo.dir, "src/created.ts"))).toBe(false);
  });

  it("T-080: diff shows only the tool's edits (snapshot vs now)", async () => {
    repo.write("src/a.ts", "A\n");
    repo.write("src/keep.ts", "KEEP\n");
    await repo.commit("init");

    const snap = await Snapshot.capture(repo.git, repo.dir);
    write("src/a.ts", "A_EDITED\n"); // the tool's edit
    write("src/added.ts", "ADDED\n"); // the tool's new file

    const changed = await snap.changedSince(repo.git);

    expect(changed).toStrictEqual(["src/a.ts", "src/added.ts"]);
  });

  describe("restore returns the index to the captured state (working tree AND index)", () => {
    it("preserves a pre-existing staged change", async () => {
      repo.write("a.ts", "A\n");
      await repo.commit("init");
      write("a.ts", "S\n");
      await repo.git.add(["a.ts"]); // staged before the run

      const snap = await Snapshot.capture(repo.git, repo.dir);
      // Something stages a different version after capture (e.g. the run, or the user).
      write("a.ts", "TOOL\n");
      await repo.git.add(["a.ts"]);

      await snap.restore(repo.git);

      expect(await staged()).toStrictEqual(["a.ts"]);
      expect(await unstaged()).toStrictEqual([]);
      expect(read("a.ts")).toBe("S\n");
    });

    it("preserves a pre-existing unstaged change", async () => {
      repo.write("a.ts", "A\n");
      await repo.commit("init");
      write("a.ts", "U\n"); // unstaged worktree edit; index still A

      const snap = await Snapshot.capture(repo.git, repo.dir);
      write("a.ts", "TOOL\n");
      await repo.git.add(["a.ts"]);

      await snap.restore(repo.git);

      expect(await staged()).toStrictEqual([]);
      expect(await unstaged()).toStrictEqual(["a.ts"]);
      expect(read("a.ts")).toBe("U\n");
    });

    it("leaves a clean repo clean — no staged/unstaged split", async () => {
      repo.write("a.ts", "A\n");
      await repo.commit("init");

      const snap = await Snapshot.capture(repo.git, repo.dir);
      // Stage something after capture; undo must return to the clean pre-run state.
      write("a.ts", "STAGED_AFTER\n");
      await repo.git.add(["a.ts"]);

      await snap.restore(repo.git);

      expect(await porcelain()).toStrictEqual([]);
      expect(read("a.ts")).toBe("A\n");
    });
  });

  it("keeps .tend/ artifacts out of git status (not reported as untracked)", async () => {
    repo.write("a.ts", "A\n");
    await repo.commit("init");
    repo.write(".tend/report.json", "{}\n");

    await Snapshot.capture(repo.git, repo.dir);

    expect((await porcelain()).some((l) => l.includes(".tend"))).toBe(false);
  });

  it("ignores unsafe pager/editor env while capturing, diffing, and restoring", async () => {
    const previous = {
      EDITOR: process.env.EDITOR,
      VISUAL: process.env.VISUAL,
      GIT_EDITOR: process.env.GIT_EDITOR,
      GIT_SEQUENCE_EDITOR: process.env.GIT_SEQUENCE_EDITOR,
      GIT_PAGER: process.env.GIT_PAGER,
      PAGER: process.env.PAGER,
    };

    process.env.EDITOR = "code --wait";
    process.env.VISUAL = "vim";
    process.env.GIT_EDITOR = "echo editor";
    process.env.GIT_SEQUENCE_EDITOR = "echo sequence-editor";
    process.env.GIT_PAGER = "less";
    process.env.PAGER = "less";

    try {
      repo.write("src/a.ts", "A\n");
      repo.write("src/b.ts", "B\n");
      await repo.commit("init");

      const hostileGit = createGit(repo.dir);
      const snap = await Snapshot.capture(hostileGit, repo.dir);
      write("src/a.ts", "A_EDITED\n");
      write("src/b.ts", "B_EDITED\n");
      write("src/new.ts", "NEW\n");

      expect(await snap.changedSince(createGit(repo.dir))).toStrictEqual(["src/a.ts", "src/b.ts", "src/new.ts"]);

      await snap.restoreFile("src/a.ts");
      expect(read("src/a.ts")).toBe("A\n");
      expect(read("src/b.ts")).toBe("B_EDITED\n");

      await snap.restore(createGit(repo.dir));
      expect(read("src/b.ts")).toBe("B\n");
      expect(existsSync(join(repo.dir, "src/new.ts"))).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  describe("parentSha — detects whether anything was committed since capture", () => {
    it("returns HEAD-at-capture even when the captured tree was dirty (no commit yet)", async () => {
      repo.write("src/a.ts", "A\n");
      await repo.commit("init");
      const baseHead = (await repo.git.revparse(["HEAD"])).trim();

      // Snapshot a dirty tree: the snapshot legitimately differs from HEAD with no commit yet.
      write("src/a.ts", "WIP\n");
      const snap = await Snapshot.capture(repo.git, repo.dir);

      // No commit since capture → parent == current HEAD (this is how the guard tells nothing
      // was committed, which diff(snapshot, HEAD) couldn't on a dirty capture).
      expect(await snap.parentSha()).toBe(baseHead);
      expect((await repo.git.revparse(["HEAD"])).trim()).toBe(baseHead);

      // Commit the edits → HEAD moves off the snapshot's (fixed) parent.
      await repo.commit("keep edits");
      expect((await repo.git.revparse(["HEAD"])).trim()).not.toBe(baseHead);
      expect(await snap.parentSha()).toBe(baseHead);
    });

    it("returns null for a snapshot captured with no commits in the repo", async () => {
      repo.write("src/a.ts", "A\n"); // never committed — repo has no HEAD
      const snap = await Snapshot.capture(repo.git, repo.dir);
      expect(await snap.parentSha()).toBeNull();
    });
  });
});
