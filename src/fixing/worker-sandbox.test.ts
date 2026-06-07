import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createGit } from "../git/client.js";
import { tmpRepo, type TmpRepo } from "../../test/helpers/tmp-repo.js";
import { makeFinding } from "../../test/helpers/make-finding.js";
import type { WorkUnit } from "./dispatch.js";
import { WorkerSandboxPool } from "./worker-sandbox.js";

let repo: TmpRepo | undefined;
const pools: WorkerSandboxPool[] = [];

afterEach(async () => {
  await Promise.all(pools.map((pool) => pool.dispose()));
  pools.length = 0;
  repo?.cleanup();
  repo = undefined;
});

async function setupRepo(): Promise<{ repo: TmpRepo; snapshotSha: string }> {
  repo = await tmpRepo();
  repo.write("src/a.ts", "export const a = 1;\n");
  repo.write("src/b.ts", "export const b = 1;\n");
  await repo.commit("initial");
  const snapshotSha = (await repo.git.revparse(["HEAD"])).trim();
  return { repo, snapshotSha };
}

function unit(files = ["src/a.ts"]): WorkUnit {
  return {
    file: files[0] ?? "src/a.ts",
    files,
    findings: [makeFinding({ file: files[0] ?? "src/a.ts" })],
    strategy: "single-file-ai-edit",
    strategies: ["single-file-ai-edit"],
  };
}

function makePool(snapshotSha: string, maxSandboxes = 2): WorkerSandboxPool {
  if (!repo) throw new Error("repo not set");
  const pool = new WorkerSandboxPool({
    mainRoot: repo.dir,
    snapshotSha,
    maxSandboxes,
    packageManager: "pnpm",
    prepareDependencies: false,
  });
  pools.push(pool);
  return pool;
}

describe("WorkerSandboxPool", () => {
  it("gives concurrent workers unique cwd values outside the main worktree", async () => {
    const { repo, snapshotSha } = await setupRepo();
    const pool = makePool(snapshotSha, 2);
    const seen = await Promise.all([
      pool.withSandbox(async (sandbox) => {
        await delay(25);
        return sandbox.cwd;
      }),
      pool.withSandbox(async (sandbox) => sandbox.cwd),
    ]);

    expect(seen[0]).not.toBe(seen[1]);
    expect(seen).not.toContain(repo.dir);
  });

  it("keeps failed worker edits inside the sandbox", async () => {
    const { repo, snapshotSha } = await setupRepo();
    const pool = makePool(snapshotSha, 1);

    await expect(
      pool.withSandbox(async (sandbox) => {
        writeFileSync(join(sandbox.cwd, "src/a.ts"), "export const a = 2;\n");
        throw new Error("gate failed");
      }),
    ).rejects.toThrow("gate failed");

    expect(readFileSync(join(repo.dir, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
  });

  it("rejects patches that touch unowned files", async () => {
    const { repo, snapshotSha } = await setupRepo();
    const pool = makePool(snapshotSha, 1);

    const result = await pool.withSandbox(async (sandbox) => {
      writeFileSync(join(sandbox.cwd, "src/b.ts"), "export const b = 2;\n");
      return sandbox.collectPatch(unit(["src/a.ts"]));
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: "unowned-patch" });
    expect(readFileSync(join(repo.dir, "src/b.ts"), "utf8")).toBe("export const b = 1;\n");
  });

  it("checks a patch with git apply --check --3way before applying and leaves main unchanged on conflict", async () => {
    const { repo, snapshotSha } = await setupRepo();
    const pool = makePool(snapshotSha, 1);

    const patch = await pool.withSandbox(async (sandbox) => {
      writeFileSync(join(sandbox.cwd, "src/a.ts"), "export const a = 2;\n");
      writeFileSync(join(sandbox.cwd, "src/b.ts"), "export const b = 2;\n");
      const result = await sandbox.collectPatch(unit(["src/a.ts", "src/b.ts"]));
      if (!result.ok) throw new Error(result.detail);
      return result.patch;
    });

    writeFileSync(join(repo.dir, "src/a.ts"), "export const a = 99;\n");
    const applied = await pool.applyPatchToMain(patch);

    expect(applied.ok).toBe(false);
    expect(applied).toMatchObject({ reason: "patch-conflict" });
    expect(readFileSync(join(repo.dir, "src/a.ts"), "utf8")).toBe("export const a = 99;\n");
    expect(readFileSync(join(repo.dir, "src/b.ts"), "utf8")).toBe("export const b = 1;\n");
  });

  it("removes worktrees after success and failure paths", async () => {
    const { repo, snapshotSha } = await setupRepo();
    const pool = makePool(snapshotSha, 2);
    const successCwd = await pool.withSandbox(async (sandbox) => sandbox.cwd);
    let failureCwd = "";

    await expect(
      pool.withSandbox(async (sandbox) => {
        failureCwd = sandbox.cwd;
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");

    await pool.dispose();
    const worktrees = await createGit(repo.dir).raw(["worktree", "list", "--porcelain"]);
    expect(worktrees).not.toContain(successCwd);
    expect(worktrees).not.toContain(failureCwd);
    expect(existsSync(successCwd)).toBe(false);
    expect(existsSync(failureCwd)).toBe(false);
  });
});
