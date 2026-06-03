import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tmpRepo, type TmpRepo } from "../../test/helpers/tmp-repo.js";
import { Snapshot } from "./snapshot.js";

let repo: TmpRepo;
beforeEach(async () => {
  repo = await tmpRepo();
});
afterEach(() => repo.cleanup());

const read = (p: string) => readFileSync(join(repo.dir, p), "utf8");
const write = (p: string, c: string) => writeFileSync(join(repo.dir, p), c);

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

  it("ignores unsafe pager/editor env while capturing, diffing, and restoring", async () => {
    const previous = {
      GIT_EDITOR: process.env.GIT_EDITOR,
      GIT_PAGER: process.env.GIT_PAGER,
      GIT_SEQUENCE_EDITOR: process.env.GIT_SEQUENCE_EDITOR,
      PAGER: process.env.PAGER,
    };

    process.env.GIT_EDITOR = "echo editor";
    process.env.GIT_PAGER = "cat";
    process.env.GIT_SEQUENCE_EDITOR = "echo sequence-editor";
    process.env.PAGER = "cat";

    try {
      repo.write("src/a.ts", "A\n");
      repo.write("src/b.ts", "B\n");
      await repo.commit("init");

      const snap = await Snapshot.capture(repo.git, repo.dir);
      write("src/a.ts", "A_EDITED\n");
      write("src/b.ts", "B_EDITED\n");
      write("src/new.ts", "NEW\n");

      expect(await snap.changedSince(repo.git)).toStrictEqual(["src/a.ts", "src/b.ts", "src/new.ts"]);

      await snap.restoreFile("src/a.ts");
      expect(read("src/a.ts")).toBe("A\n");
      expect(read("src/b.ts")).toBe("B_EDITED\n");

      await snap.restore(repo.git);
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
});
