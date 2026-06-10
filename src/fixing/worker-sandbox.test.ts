import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGit } from "../git/client.js";
import { tmpRepo, type TmpRepo } from "../../test/helpers/tmp-repo.js";
import { makeFinding } from "../../test/helpers/make-finding.js";
import type { PackageManager } from "../detect/package-manager.js";
import type { WorkUnit } from "./dispatch.js";
import { pruneStaleWorktrees, shouldReinstall, WorkerSandboxPool } from "./worker-sandbox.js";

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

/** An exec that records package-manager install invocations and delegates git to real execa. */
function installRecordingExec() {
  const installCalls: { pm: PackageManager; args: string[] }[] = [];
  const fn = vi.fn(async (file: string, args: string[], options?: { cwd?: string; input?: string; reject?: boolean }) => {
    if (file !== "git") {
      installCalls.push({ pm: file as PackageManager, args });
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    const { execa } = await import("execa");
    return execa(file, args, { ...options, reject: false });
  });
  return Object.assign(fn, { installCalls });
}

function makeInstallPool(snapshotSha: string, exec: ReturnType<typeof installRecordingExec>): WorkerSandboxPool {
  if (!repo) throw new Error("repo not set");
  const pool = new WorkerSandboxPool({
    mainRoot: repo.dir,
    snapshotSha,
    maxSandboxes: 1,
    packageManager: "pnpm",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    exec: exec as any,
  });
  pools.push(pool);
  return pool;
}

describe("shouldReinstall — reuse vs reinstall decision", () => {
  const manifestUnit = (file: string): WorkUnit => ({
    file,
    files: [file],
    findings: [makeFinding({ file })],
  });

  it("reuses deps when the unit touches no dependency manifest", () => {
    expect(shouldReinstall(unit(["src/a.ts"]))).toBe(false);
    expect(shouldReinstall(unit(["src/a.ts", "src/a.test.ts"]))).toBe(false);
  });

  it.each(["package.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "package-lock.json", "npm-shrinkwrap.json"])(
    "reinstalls when the unit includes %s",
    (manifest) => {
      expect(shouldReinstall(manifestUnit(manifest))).toBe(true);
      expect(shouldReinstall(manifestUnit(`packages/app/${manifest}`))).toBe(true);
    },
  );

  it("decides identically across package managers (decision is manifest-driven, not pm-driven)", () => {
    // The matrix: a source-only unit reuses, a manifest unit reinstalls — for every pm.
    const pms: PackageManager[] = ["npm", "pnpm", "yarn", "bun"];
    for (const _pm of pms) {
      expect(shouldReinstall(unit(["src/a.ts"]))).toBe(false);
      expect(shouldReinstall(manifestUnit("package.json"))).toBe(true);
    }
  });
});

describe("WorkerSandboxPool", () => {
  it("gives concurrent workers unique cwd values outside the main worktree", async () => {
    const { repo, snapshotSha } = await setupRepo();
    const pool = makePool(snapshotSha, 2);
    const seen = await Promise.all([
      pool.withSandbox(unit(["src/a.ts"]), async (sandbox) => {
        await delay(25);
        return sandbox.cwd;
      }),
      pool.withSandbox(unit(["src/b.ts"]), async (sandbox) => sandbox.cwd),
    ]);

    expect(seen[0]).not.toBe(seen[1]);
    expect(seen).not.toContain(repo.dir);
  });

  it("keeps failed worker edits inside the sandbox", async () => {
    const { repo, snapshotSha } = await setupRepo();
    const pool = makePool(snapshotSha, 1);

    await expect(
      pool.withSandbox(unit(["src/a.ts"]), async (sandbox) => {
        writeFileSync(join(sandbox.cwd, "src/a.ts"), "export const a = 2;\n");
        throw new Error("gate failed");
      }),
    ).rejects.toThrow("gate failed");

    expect(readFileSync(join(repo.dir, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
  });

  it("rejects patches that touch unowned files", async () => {
    const { repo, snapshotSha } = await setupRepo();
    const pool = makePool(snapshotSha, 1);

    const result = await pool.withSandbox(unit(["src/a.ts"]), async (sandbox) => {
      writeFileSync(join(sandbox.cwd, "src/b.ts"), "export const b = 2;\n");
      return sandbox.collectPatch(unit(["src/a.ts"]));
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: "unowned-patch" });
    expect(readFileSync(join(repo.dir, "src/b.ts"), "utf8")).toBe("export const b = 1;\n");
  });

  it("does not treat the tend-created node_modules symlink as an unowned file when .gitignore uses the dir-only `node_modules/` pattern", async () => {
    // The GitHub Node .gitignore template ships `node_modules/` (trailing slash), which matches
    // directories only — git sees the symlink tend places in the worktree as an untracked FILE,
    // so without filtering, every patch from every worker was reverted as "unowned".
    const { repo } = await setupRepo();
    repo.write(".gitignore", "node_modules/\n");
    await repo.commit("ignore node_modules dir-only");
    const base = (await repo.git.revparse(["HEAD"])).trim();
    mkdirSync(join(repo.dir, "node_modules"), { recursive: true });

    const exec = installRecordingExec();
    const pool = makeInstallPool(base, exec);
    const result = await pool.withSandbox(unit(["src/a.ts"]), async (sandbox) => {
      // prepare() symlinked main's node_modules; confirm git really reports it as untracked
      // (the condition from the bug report), then collect a legitimate single-file fix.
      expect(lstatSync(join(sandbox.cwd, "node_modules")).isSymbolicLink()).toBe(true);
      writeFileSync(join(sandbox.cwd, "src/a.ts"), "export const a = 2;\n");
      return sandbox.collectPatch(unit(["src/a.ts"]));
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.changedFiles).toEqual(["src/a.ts"]);
  });

  it("ignores untracked files inside a real node_modules tree when the repo does not ignore node_modules at all", async () => {
    const { repo, snapshotSha } = await setupRepo();
    const pool = makePool(snapshotSha, 1);

    const result = await pool.withSandbox(unit(["src/a.ts"]), async (sandbox) => {
      // Simulate a per-sandbox install in a repo with no .gitignore: every installed file
      // shows up as untracked, none of it is the worker's doing.
      mkdirSync(join(sandbox.cwd, "node_modules", "pkg"), { recursive: true });
      writeFileSync(join(sandbox.cwd, "node_modules", "pkg", "index.js"), "module.exports = {};\n");
      writeFileSync(join(sandbox.cwd, "src/a.ts"), "export const a = 2;\n");
      return sandbox.collectPatch(unit(["src/a.ts"]));
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.changedFiles).toEqual(["src/a.ts"]);
  });

  it("leaves the main working tree untouched (no conflict markers) when a patch genuinely conflicts", async () => {
    const { repo, snapshotSha } = await setupRepo();
    const pool = makePool(snapshotSha, 1);

    const patch = await pool.withSandbox(unit(["src/a.ts", "src/b.ts"]), async (sandbox) => {
      writeFileSync(join(sandbox.cwd, "src/a.ts"), "export const a = 2;\n");
      writeFileSync(join(sandbox.cwd, "src/b.ts"), "export const b = 2;\n");
      const result = await sandbox.collectPatch(unit(["src/a.ts", "src/b.ts"]));
      if (!result.ok) throw new Error(result.detail);
      return result.patch;
    });

    // Main tree diverged at the same line the patch rewrites → a real 3-way conflict.
    writeFileSync(join(repo.dir, "src/a.ts"), "export const a = 99;\n");
    const applied = await pool.applyPatchToMain(patch, ["src/a.ts", "src/b.ts"]);

    expect(applied.ok).toBe(false);
    expect(applied).toMatchObject({ reason: "patch-conflict" });
    // No conflict markers, no partial application of the clean half of the patch.
    expect(readFileSync(join(repo.dir, "src/a.ts"), "utf8")).toBe("export const a = 99;\n");
    expect(readFileSync(join(repo.dir, "src/b.ts"), "utf8")).toBe("export const b = 1;\n");
  });

  it("applies a snapshot-relative patch onto a DIRTY working tree (index ≠ worktree) without 'does not match index'", async () => {
    const { repo } = await setupRepo();
    // A multi-line file so the user's edit and the fix sit in non-overlapping regions.
    repo.write("src/a.ts", "L1\nL2\nL3\nL4\nL5\n");
    await repo.commit("widen a.ts");
    const snapshotSha = (await repo.git.revparse(["HEAD"])).trim();
    const pool = makePool(snapshotSha, 1);

    // Fix rewrites the LAST line, captured against the snapshot.
    const patch = await pool.withSandbox(unit(["src/a.ts"]), async (sandbox) => {
      writeFileSync(join(sandbox.cwd, "src/a.ts"), "L1\nL2\nL3\nL4\nL5-fixed\n");
      const result = await sandbox.collectPatch(unit(["src/a.ts"]));
      if (!result.ok) throw new Error(result.detail);
      return result.patch;
    });

    // Make the main repo dirty in a FAR-AWAY region (line 1): an uncommitted user edit.
    // Now the index (committed L1) ≠ working tree — the exact condition that broke `--3way`.
    writeFileSync(join(repo.dir, "src/a.ts"), "L1-user\nL2\nL3\nL4\nL5\n");
    const applied = await pool.applyPatchToMain(patch, ["src/a.ts"]);

    expect(applied.ok).toBe(true);
    // Both the user's uncommitted edit AND the fix survive the 3-way merge.
    expect(readFileSync(join(repo.dir, "src/a.ts"), "utf8")).toBe("L1-user\nL2\nL3\nL4\nL5-fixed\n");
    // The user's real index was never touched: a.ts is still staged at its committed content.
    const staged = await createGit(repo.dir).raw(["show", ":src/a.ts"]);
    expect(staged).toBe("L1\nL2\nL3\nL4\nL5\n");
  });

  it("applies sequential snapshot-relative patches to the same file (patch 2 merges onto patch 1's result)", async () => {
    const { repo, snapshotSha } = await setupRepo();
    const pool = makePool(snapshotSha, 1);
    // a.ts starts as a 3-line file so the two patches touch non-adjacent lines.
    repo.write("src/a.ts", "L1\nL2\nL3\n");
    await repo.commit("widen a.ts");
    const base = (await repo.git.revparse(["HEAD"])).trim();
    const seqPool = new WorkerSandboxPool({
      mainRoot: repo.dir,
      snapshotSha: base,
      maxSandboxes: 1,
      packageManager: "pnpm",
      prepareDependencies: false,
    });
    pools.push(seqPool);

    const make = async (content: string): Promise<string> =>
      seqPool.withSandbox(unit(["src/a.ts"]), async (sandbox) => {
        writeFileSync(join(sandbox.cwd, "src/a.ts"), content);
        const result = await sandbox.collectPatch(unit(["src/a.ts"]));
        if (!result.ok) throw new Error(result.detail);
        return result.patch;
      });

    const p1 = await make("L1-edit\nL2\nL3\n"); // both vs the SAME snapshot
    const p2 = await make("L1\nL2\nL3-edit\n");

    expect((await seqPool.applyPatchToMain(p1, ["src/a.ts"])).ok).toBe(true);
    const second = await seqPool.applyPatchToMain(p2, ["src/a.ts"]);
    expect(second.ok).toBe(true);
    // p2 was diffed against the snapshot (L1/L2/L3) yet merges onto p1's already-applied result.
    expect(readFileSync(join(repo.dir, "src/a.ts"), "utf8")).toBe("L1-edit\nL2\nL3-edit\n");
  });

  it("applies sequential OVERLAPPING fixes to the same line by advancing the base (no patch-conflict)", async () => {
    // Reproduces the summary.ts stall: a file gets several fixes in sequence. Before the base
    // advanced, fix 2's sandbox forked from the frozen original, never saw fix 1, and produced a
    // diff-from-original that conflicted on apply (3-way base = original, ours = main+fix1). Now
    // each fix forks from main's already-fixed state, so overlapping edits merge cleanly.
    const { repo } = await setupRepo();
    repo.write("src/a.ts", "L1\nL2\nL3\n");
    await repo.commit("widen a.ts");
    const base = (await repo.git.revparse(["HEAD"])).trim();
    const pool = makePool(base, 1);

    // Each fix rewrites the SAME line (L2), building on whatever the sandbox currently shows —
    // exactly what a real AI session does when it edits a line a previous session already touched.
    const fixL2 = async (transform: (current: string) => string): Promise<void> => {
      const collected = await pool.withSandbox(unit(["src/a.ts"]), async (sandbox) => {
        const file = join(sandbox.cwd, "src/a.ts");
        const lines = readFileSync(file, "utf8").split("\n");
        lines[1] = transform(lines[1]!);
        writeFileSync(file, lines.join("\n"));
        return sandbox.collectPatch(unit(["src/a.ts"]));
      });
      if (!collected.ok) throw new Error(`collect failed: ${collected.detail}`);
      const applied = await pool.applyPatchToMain(collected.patch, collected.changedFiles);
      if (!applied.ok) throw new Error(`apply failed: ${applied.detail}`);
    };

    await fixL2(() => "L2-a"); // fix 1: L2 -> L2-a
    await fixL2((current) => `${current}-b`); // fix 2 edits the SAME line, building on L2-a -> L2-a-b

    // Both overlapping fixes landed; without the advancing base, fix 2 would have read "L2",
    // produced "L2-b", and conflicted against main's "L2-a".
    expect(readFileSync(join(repo.dir, "src/a.ts"), "utf8")).toBe("L1\nL2-a-b\nL3\n");
  });

  it("reuses the main repo's node_modules without running an install command", async () => {
    const { repo, snapshotSha } = await setupRepo();
    // Main checkout has installed deps.
    mkdirSync(join(repo.dir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(repo.dir, "node_modules", "marker.txt"), "from-main\n");

    const exec = installRecordingExec();
    const pool = makeInstallPool(snapshotSha, exec);
    const sandboxCwd = await pool.withSandbox(unit(["src/a.ts"]), async (sandbox) => sandbox.cwd);

    // No package-manager install was executed…
    expect(exec.installCalls).toHaveLength(0);
    // …and the worktree's node_modules resolves to the main checkout's.
    const link = join(sandboxCwd, "node_modules");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(join(repo.dir, "node_modules")));
  });

  it("runs an install when the unit changes a dependency manifest", async () => {
    const { repo, snapshotSha } = await setupRepo();
    mkdirSync(join(repo.dir, "node_modules"), { recursive: true });

    const exec = installRecordingExec();
    const pool = makeInstallPool(snapshotSha, exec);
    await pool.withSandbox(
      { file: "package.json", files: ["package.json"], findings: [makeFinding({ file: "package.json" })] },
      async (sandbox) => sandbox.cwd,
    );

    expect(exec.installCalls).toHaveLength(1);
    expect(exec.installCalls[0]).toEqual({ pm: "pnpm", args: expect.arrayContaining(["install"]) });
  });

  it("falls back to install (no crash) when the main repo has no node_modules", async () => {
    const { snapshotSha } = await setupRepo();
    // No node_modules in main.
    const exec = installRecordingExec();
    const pool = makeInstallPool(snapshotSha, exec);

    await expect(
      pool.withSandbox(unit(["src/a.ts"]), async (sandbox) => sandbox.cwd),
    ).resolves.toBeTruthy();
    expect(exec.installCalls).toHaveLength(1);
  });

  it("cancel: queued withSandbox calls reject promptly, no new sandbox is created, in-flight work finishes", async () => {
    const { snapshotSha } = await setupRepo();
    const pool = makePool(snapshotSha, 1); // one slot, so the second call stays queued

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const inFlight = pool.withSandbox(unit(["src/a.ts"]), async (sandbox) => {
      await blocked;
      return sandbox.cwd;
    });
    await delay(20); // let the first call occupy the slot
    const queued = pool.withSandbox(unit(["src/b.ts"]), async (sandbox) => sandbox.cwd);
    queued.catch(() => undefined);

    pool.cancel();
    // The queued call rejects without waiting for the in-flight one (still blocked here).
    await expect(queued).rejects.toThrow(/cancelled/);
    // New calls after cancel reject immediately.
    await expect(pool.withSandbox(unit(["src/b.ts"]), async () => "never")).rejects.toThrow(/cancelled/);

    release();
    const inFlightCwd = await inFlight; // in-flight work is not rejected out from under its sandbox

    // Only the in-flight sandbox's worktree ever existed — none was spawned for the queued unit.
    const worktrees = await createGit(repo!.dir).raw(["worktree", "list", "--porcelain"]);
    expect(worktrees).toContain(inFlightCwd);
    expect(worktrees.match(/tend-worker-/g)?.length).toBe(1);
  });

  it("cancel then dispose still removes existing worktrees", async () => {
    const { snapshotSha } = await setupRepo();
    const pool = makePool(snapshotSha, 1);
    const cwd = await pool.withSandbox(unit(["src/a.ts"]), async (sandbox) => sandbox.cwd);

    pool.cancel();
    await pool.dispose();

    expect(existsSync(cwd)).toBe(false);
    expect(await createGit(repo!.dir).raw(["worktree", "list", "--porcelain"])).not.toContain(cwd);
  });

  it("dispose is idempotent — safe to call more than once (signal + finally paths)", async () => {
    const { snapshotSha } = await setupRepo();
    const pool = makePool(snapshotSha, 1);
    await pool.withSandbox(unit(["src/a.ts"]), async (sandbox) => sandbox.cwd);

    await pool.dispose();
    await expect(pool.dispose()).resolves.toBeUndefined();
  });

  it("concurrent dispose() calls each resolve only after worktrees are actually removed", async () => {
    // The SIGINT handler and the run's finally path can call dispose() at the same time.
    // Every caller must await the real teardown — not return early while removal is in flight,
    // or the handler's process.exit() races ahead and leaks the worktree.
    const { repo, snapshotSha } = await setupRepo();
    const pool = makePool(snapshotSha, 1);
    const cwd = await pool.withSandbox(unit(["src/a.ts"]), async (sandbox) => sandbox.cwd);
    expect(existsSync(cwd)).toBe(true);

    const first = pool.dispose();
    const second = pool.dispose();
    await second; // resolving the *second* caller must mean teardown is done

    expect(existsSync(cwd)).toBe(false);
    expect(await createGit(repo.dir).raw(["worktree", "list", "--porcelain"])).not.toContain(cwd);
    await first;
  });

  it("removes worktrees after success and failure paths", async () => {
    const { repo, snapshotSha } = await setupRepo();
    const pool = makePool(snapshotSha, 2);
    const successCwd = await pool.withSandbox(unit(["src/a.ts"]), async (sandbox) => sandbox.cwd);
    let failureCwd = "";

    await expect(
      pool.withSandbox(unit(["src/b.ts"]), async (sandbox) => {
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

describe("pruneStaleWorktrees", () => {
  it("removes a stale tend-worker worktree left by a crashed prior run", async () => {
    const { repo, snapshotSha } = await setupRepo();
    const stale = join(repo.dir, "..", `tend-worker-${process.pid}-stale`);
    await repo.git.raw(["worktree", "add", "--detach", stale, snapshotSha]);
    expect(await repo.git.raw(["worktree", "list", "--porcelain"])).toContain(stale);

    await pruneStaleWorktrees(repo.dir);

    expect(await repo.git.raw(["worktree", "list", "--porcelain"])).not.toContain(stale);
    expect(existsSync(stale)).toBe(false);
  });

  it("leaves a non-tend worktree untouched", async () => {
    const { repo, snapshotSha } = await setupRepo();
    const mine = join(repo.dir, "..", `feature-branch-${process.pid}`);
    await repo.git.raw(["worktree", "add", "--detach", mine, snapshotSha]);

    await pruneStaleWorktrees(repo.dir);

    expect(await repo.git.raw(["worktree", "list", "--porcelain"])).toContain(mine);
    expect(existsSync(mine)).toBe(true);
    await repo.git.raw(["worktree", "remove", "--force", mine]);
  });

  it("does not throw on a repo with no worktrees", async () => {
    const { repo } = await setupRepo();
    await expect(pruneStaleWorktrees(repo.dir)).resolves.toBeUndefined();
  });
});
