import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tmpRepo, type TmpRepo } from "../../test/helpers/tmp-repo.js";
import { createGit } from "./client.js";
import { assertGitRepo, changedVsHead, revertFile } from "./repo.js";
import { Snapshot } from "./snapshot.js";

describe("assertGitRepo", () => {
  it("T-082: not a git repo → error", async () => {
    const plain = mkdtempSync(join(tmpdir(), "tend-nogit-"));
    try {
      await expect(assertGitRepo(createGit(plain))).rejects.toThrow(/git repo/i);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("repo ops", () => {
  let repo: TmpRepo;
  beforeEach(async () => {
    repo = await tmpRepo();
  });
  afterEach(() => repo.cleanup());

  const read = (p: string) => readFileSync(join(repo.dir, p), "utf8");
  const write = (p: string, c: string) => writeFileSync(join(repo.dir, p), c);

  it("T-083: list files changed vs HEAD", async () => {
    repo.write("a.ts", "A\n");
    await repo.commit("init");
    write("a.ts", "A2\n");
    repo.write("b.ts", "B\n");

    expect(new Set(await changedVsHead(repo.git))).toStrictEqual(new Set(["a.ts", "b.ts"]));
  });

  it("T-083b: from a subdirectory, scopes to that subtree and re-bases paths", async () => {
    repo.write("apps/dashboard/a.ts", "A\n");
    repo.write("packages/ui/b.ts", "B\n");
    await repo.commit("init");
    write("apps/dashboard/a.ts", "A2\n");
    repo.write("packages/ui/c.ts", "C\n"); // outside the dashboard subtree

    const fromDashboard = createGit(join(repo.dir, "apps/dashboard"));
    // only the dashboard change, pathed relative to the dashboard dir (no apps/dashboard/ prefix)
    expect(new Set(await changedVsHead(fromDashboard))).toStrictEqual(new Set(["a.ts"]));
  });

  it("T-084: revert a single file to snapshot", async () => {
    repo.write("a.ts", "A\n");
    repo.write("c.ts", "C\n");
    await repo.commit("init");

    const snap = await Snapshot.capture(repo.git, repo.dir);
    write("a.ts", "A_EDITED\n");
    write("c.ts", "C_EDITED\n");

    await revertFile(snap, "a.ts");

    expect(read("a.ts")).toBe("A\n"); // reverted
    expect(read("c.ts")).toBe("C_EDITED\n"); // untouched — only a.ts reverted
  });
});
