import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

/** Prefix every tend sandbox worktree directory carries, so we can recognize our own. */
const WORKTREE_PREFIX = "tend-worker-";
import { execa, type Options as ExecaOptions } from "execa";
import PQueue from "p-queue";
import { createGit } from "../git/client.js";
import { writeWorkingTree } from "../git/snapshot.js";
import type { PackageManager } from "../detect/package-manager.js";
import type { WorkUnit } from "./dispatch.js";

/** Pins the moving sandbox base commit so `git gc` can't prune it (it's on no branch). */
const SANDBOX_BASE_REF = "refs/tend/sandbox-base";

type Exec = (
  file: string,
  args: string[],
  options?: ExecaOptions,
) => Promise<{ stdout: string; stderr: string; exitCode?: number | null; failed?: boolean }>;

export class SandboxSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxSetupError";
  }
}

export type PatchResult =
  | { ok: true; patch: string; changedFiles: string[] }
  | { ok: false; reason: "unowned-patch"; detail: string; changedFiles: string[] };

type ApplyPatchResult =
  | { ok: true }
  | { ok: false; reason: "patch-conflict"; detail: string };

export type WorkerSandbox = {
  readonly cwd: string;
  /** Reset the worktree to `baseSha` and remember it as the base this sandbox's patch is diffed against. */
  reset(baseSha: string): Promise<void>;
  prepare(unit: WorkUnit): Promise<void>;
  collectPatch(unit: WorkUnit): Promise<PatchResult>;
  dispose(): Promise<void>;
};

/**
 * Files whose presence in a unit means the install graph may have changed, so a sandbox
 * must reinstall rather than reuse the main checkout's node_modules. Matched by basename,
 * so nested-package manifests (e.g. `packages/app/package.json`) count too.
 */
const DEPENDENCY_MANIFESTS = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
]);

/**
 * The reuse decision (Fix 4): a sandbox can reuse the main repo's installed deps unless
 * the unit edits a dependency manifest, in which case it must reinstall. Package-manager-
 * agnostic — driven entirely by which files the unit may change.
 */
export function shouldReinstall(unit: WorkUnit): boolean {
  return allowedPatchFiles(unit).some((file) => DEPENDENCY_MANIFESTS.has(basename(normalizeRel(file))));
}

type SandboxPoolDeps = {
  mainRoot: string;
  snapshotSha: string;
  maxSandboxes: number;
  packageManager: PackageManager;
  prepareDependencies?: boolean;
  exec?: Exec;
  tempRoot?: string;
};

const cleanExcludes = [
  "node_modules",
  "node_modules/**",
  "**/node_modules",
  "**/node_modules/**",
];

function normalizeRel(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.?\//, "");
}

function lines(raw: string): string[] {
  return raw.split("\n").map((line) => normalizeRel(line.trim())).filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(normalizeRel))];
}

function isGeneratedRepair(unit: WorkUnit): boolean {
  return unit.strategy === "generated-source-repair" || unit.strategies?.includes("generated-source-repair") === true;
}

function allowedPatchFiles(unit: WorkUnit): string[] {
  return unique([
    ...unit.files,
    ...(isGeneratedRepair(unit) ? (unit.verificationTargets ?? []) : []),
  ]);
}

function installArgs(pm: PackageManager): string[] {
  switch (pm) {
    case "pnpm":
      return ["install", "--frozen-lockfile", "--prefer-offline"];
    case "yarn":
      return ["install", "--frozen-lockfile", "--prefer-offline"];
    case "bun":
      return ["install", "--frozen-lockfile"];
    case "npm":
      return ["ci", "--prefer-offline"];
  }
}

class GitWorkerSandbox implements WorkerSandbox {
  // Tracks how deps were last set up so a recycled sandbox doesn't redo equivalent work:
  // "reuse" symlinks the main node_modules; "install" is a real per-worktree install.
  private preparedMode: "none" | "reuse" | "install" = "none";
  // The commit this sandbox was last reset to. Its patch is diffed against THIS base — never the
  // pool's current base, which may have advanced under concurrent same-run sandboxes.
  private baseSha: string;

  constructor(
    readonly cwd: string,
    private readonly deps: SandboxPoolDeps & { exec: Exec },
  ) {
    this.baseSha = deps.snapshotSha;
  }

  async reset(baseSha: string): Promise<void> {
    this.baseSha = baseSha;
    const git = createGit(this.cwd);
    await git.raw(["reset", "--hard", baseSha]);
    // node_modules is preserved across resets (excluded from clean), so a reused symlink
    // or prior install survives for the next unit on this recycled sandbox.
    await git.raw(["clean", "-ffdx", ...cleanExcludes.flatMap((pattern) => ["-e", pattern])]);
  }

  async prepare(unit: WorkUnit): Promise<void> {
    if (this.deps.prepareDependencies === false) return;

    // A unit that touches a dependency manifest needs a real, isolated install — never a
    // symlink that would mutate the main checkout's node_modules. Anything else can reuse.
    if (shouldReinstall(unit)) {
      if (this.preparedMode === "install") return;
      this.removeNodeModulesLink();
      await this.install();
      this.preparedMode = "install";
      return;
    }

    if (this.preparedMode !== "none") return;
    if (this.tryReuseMainDeps()) {
      this.preparedMode = "reuse";
      return;
    }
    // No main node_modules to borrow → fall back to a real install.
    await this.install();
    this.preparedMode = "install";
  }

  /** Symlink the main repo's node_modules into this worktree. Returns false if main has none. */
  private tryReuseMainDeps(): boolean {
    const mainModules = join(this.deps.mainRoot, "node_modules");
    if (!existsSync(mainModules)) return false;
    const link = join(this.cwd, "node_modules");
    if (existsSync(link)) return true;
    symlinkSync(mainModules, link, "junction");
    return true;
  }

  private removeNodeModulesLink(): void {
    const link = join(this.cwd, "node_modules");
    // Only ever remove a symlink we created; never recurse into a real installed tree.
    rmSync(link, { force: true });
  }

  private async install(): Promise<void> {
    const args = installArgs(this.deps.packageManager);
    const result = await this.deps.exec(this.deps.packageManager, args, {
      cwd: this.cwd,
      reject: false,
      timeout: 10 * 60_000,
    });
    if ((result.exitCode ?? 1) !== 0) {
      throw new SandboxSetupError(
        `sandbox dependency install failed: ${result.stderr || result.stdout || ("exit " + (result.exitCode ?? 1))}`,
      );
    }
  }

  async collectPatch(unit: WorkUnit): Promise<PatchResult> {
    const git = createGit(this.cwd);
    const tracked = lines(await git.raw(["diff", "--name-only", this.baseSha]));
    const untracked = lines(await git.raw(["ls-files", "--others", "--exclude-standard"]));
    const changedFiles = unique([...tracked, ...untracked]).sort();
    const allowed = new Set(allowedPatchFiles(unit));
    const unowned = changedFiles.filter((file) => !allowed.has(file));
    if (unowned.length > 0) {
      return {
        ok: false,
        reason: "unowned-patch",
        detail: `Worker modified unowned files: ${unowned.join(", ")}`,
        changedFiles,
      };
    }
    const allowedFiles = [...allowed].sort();
    if (allowedFiles.length === 0 || changedFiles.length === 0)
      return { ok: true, patch: "", changedFiles };
    if (untracked.length > 0) {
      await git.raw(["add", "-N", "--", ...untracked.filter((file) => allowed.has(file))]);
    }
    const patch = await git.raw(["diff", "--binary", this.baseSha, "--", ...allowedFiles]);
    return { ok: true, patch, changedFiles };
  }

  async dispose(): Promise<void> {
    const git = createGit(this.deps.mainRoot);
    try {
      await git.raw(["worktree", "remove", "--force", this.cwd]);
    } finally {
      rmSync(this.cwd, { recursive: true, force: true });
    }
  }
}

export class WorkerSandboxPool {
  private readonly queue: PQueue;
  private readonly applyQueue = new PQueue({ concurrency: 1 });
  private readonly idle: GitWorkerSandbox[] = [];
  private readonly sandboxes = new Set<GitWorkerSandbox>();
  private counter = 0;
  private disposing?: Promise<void>;
  private cancelled = false;
  // Rejecters for withSandbox calls still WAITING in the queue; cancel() fires them so queued
  // work rejects promptly instead of starting a fresh sandbox after Ctrl-C.
  private readonly queuedRejecters = new Set<(error: Error) => void>();
  private readonly exec: Exec;
  // The base every new sandbox forks from. Starts at the run snapshot and ADVANCES after each
  // accepted patch (see advanceBase), so a later session forks from main's already-fixed state
  // instead of the original — the diff-from-frozen-original is what made sequential fixes to the
  // same file conflict on apply.
  private currentBase: string;

  constructor(private readonly deps: SandboxPoolDeps) {
    this.queue = new PQueue({ concurrency: deps.maxSandboxes });
    this.exec = (deps.exec ?? execa) as Exec;
    this.currentBase = deps.snapshotSha;
  }

  /**
   * Stop accepting and starting work (Ctrl-C / SIGTERM): queued withSandbox calls reject
   * promptly with SandboxSetupError("cancelled") instead of spawning new sandboxes, and the
   * queue is cleared so dispose() never waits on work that was never started. In-flight
   * sandboxes are left to finish — their AI sessions are killed separately via the run's
   * AbortSignal, so they return quickly with a failure outcome.
   */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.queue.clear();
    const error = new SandboxSetupError("cancelled");
    for (const reject of [...this.queuedRejecters]) reject(error);
    this.queuedRejecters.clear();
  }

  async withSandbox<T>(unit: WorkUnit, run: (sandbox: WorkerSandbox) => Promise<T>): Promise<T> {
    if (this.cancelled) throw new SandboxSetupError("cancelled");
    let rejectQueued!: (error: Error) => void;
    const queuedRejection = new Promise<never>((_, reject) => {
      rejectQueued = reject;
      this.queuedRejecters.add(reject);
    });
    const task = this.queue.add(async () => {
      // Started: this call is now in-flight, not queued — it runs to its natural end (its AI
      // session is killed via the run's cancel signal) rather than being rejected out from
      // under a live sandbox.
      this.queuedRejecters.delete(rejectQueued);
      if (this.cancelled) throw new SandboxSetupError("cancelled");
      let sandbox: GitWorkerSandbox;
      try {
        sandbox = await this.acquire();
      } catch (error) {
        throw new SandboxSetupError(error instanceof Error ? error.message : String(error));
      }
      try {
        await sandbox.reset(this.currentBase);
        await sandbox.prepare(unit);
      } catch (error) {
        this.idle.push(sandbox);
        const message = error instanceof Error ? error.message : String(error);
        throw error instanceof SandboxSetupError ? error : new SandboxSetupError(message);
      }
      try {
        return await run(sandbox);
      } finally {
        this.idle.push(sandbox);
      }
    }) as Promise<T>;
    // A task cleared from the queue by cancel() never settles; a late in-flight rejection
    // after the race has already rejected must not surface as unhandled.
    task.catch(() => undefined);
    try {
      return await Promise.race([task, queuedRejection]);
    } finally {
      this.queuedRejecters.delete(rejectQueued);
    }
  }

  /**
   * Apply a snapshot-relative patch onto the main working tree with 3-way-merge fallback,
   * tolerating a dirty repo (index ≠ working tree) and sequential patches to the same file.
   *
   * Why not plain `git apply --3way`: `--3way` implies `--index` (git-apply docs; apply.c
   * `try_threeway`), and `--index` "expects index entries and working tree copies for relevant
   * paths to be identical … and will raise an error if they are not". Tend's normal case is a
   * dirty tree, so the index never matches the working tree and the apply fails with
   * "src/…: does not match index" — emitted by apply.c `check_preimage`:
   *   `if (!state->cached && verify_index_match(state, *ce, st)) return error("%s: does not match index")`
   * The guard is `!state->cached`, so `--cached` bypasses the index/worktree match entirely.
   *
   * Approach: run the merge against a *throwaway* index (GIT_INDEX_FILE) seeded from the current
   * working-tree content of the target files, so "ours" in the 3-way merge is the live tree
   * (correct for sequential patches: patch N merges onto patch N-1's result). `--3way --cached`
   * writes only to that temp index, never the working tree, so a conflict can never leave conflict
   * markers behind. Conflicts surface as a non-zero exit (apply.c prints "Applied patch … with
   * conflicts.") plus unmerged stages; we abort before materializing, leaving the tree untouched.
   * On a clean merge we materialize just the target paths from the temp index via checkout-index
   * (deleting any the patch removed). The user's real index is never touched.
   */
  async applyPatchToMain(patch: string, files: string[]): Promise<ApplyPatchResult> {
    return this.applyQueue.add(async () => {
      if (patch.trim() === "") return { ok: true };
      const main = this.deps.mainRoot;
      const targets = unique(files);
      const tmpIndex = join(tmpdir(), `${WORKTREE_PREFIX}apply-${process.pid}.index`);
      const tmpEnv = { GIT_INDEX_FILE: tmpIndex };
      rmSync(tmpIndex, { force: true });
      rmSync(`${tmpIndex}.lock`, { force: true });
      try {
        // Seed the throwaway index with the live working-tree content of the target files so the
        // 3-way merge's "ours" side is the current tree (handles uncommitted changes + prior patches).
        // New files in the patch don't exist yet, so only stage the ones already on disk.
        const existing = targets.filter((file) => existsSync(join(main, file)));
        if (existing.length > 0) {
          const seed = await this.exec("git", ["add", "--force", "--", ...existing], {
            cwd: main,
            env: tmpEnv,
            reject: false,
          });
          if ((seed.exitCode ?? 1) !== 0) {
            return { ok: false, reason: "patch-conflict", detail: seed.stderr || "failed to stage target files" };
          }
        }
        // Apply only into the temp index. The working tree is never written here, so a conflict
        // leaves it clean — no markers, nothing partial.
        const applied = await this.exec("git", ["apply", "--3way", "--cached", "--binary"], {
          cwd: main,
          input: patch,
          env: tmpEnv,
          reject: false,
        });
        const unmerged = await this.exec("git", ["ls-files", "--unmerged"], {
          cwd: main,
          env: tmpEnv,
          reject: false,
        });
        if ((applied.exitCode ?? 1) !== 0 || unmerged.stdout.trim() !== "") {
          return {
            ok: false,
            reason: "patch-conflict",
            detail: applied.stderr || applied.stdout || "git apply --3way --cached conflicted",
          };
        }
        // Clean merge: materialize the result onto the working tree. Files the patch deleted are
        // gone from the temp index; remove them from disk. The rest are written from the index.
        const survivorsRaw = await this.exec("git", ["ls-files", "--", ...targets], {
          cwd: main,
          env: tmpEnv,
          reject: false,
        });
        const survivors = new Set(lines(survivorsRaw.stdout));
        for (const file of targets) {
          if (!survivors.has(normalizeRel(file))) rmSync(join(main, file), { force: true });
        }
        if (survivors.size > 0) {
          const out = await this.exec("git", ["checkout-index", "-f", "--", ...survivors], {
            cwd: main,
            env: tmpEnv,
            reject: false,
          });
          if ((out.exitCode ?? 1) !== 0) {
            return { ok: false, reason: "patch-conflict", detail: out.stderr || "failed to materialize merged files" };
          }
        }
        // The patch is now on main. Advance the base so the NEXT sandbox forks from this result
        // instead of the frozen original — otherwise a later fix to the same file would be a
        // diff-from-original and conflict here on the 3-way merge. Runs inside applyQueue
        // (concurrency 1), so it can't race another apply.
        await this.advanceBase();
        return { ok: true };
      } finally {
        rmSync(tmpIndex, { force: true });
        rmSync(`${tmpIndex}.lock`, { force: true });
      }
    }) as Promise<ApplyPatchResult>;
  }

  /**
   * Capture main's current working tree as a commit (reusing git's content store — near-instant,
   * a few KB) parented on the previous base, pin it with a private ref so gc can't prune it, and
   * make it the base future sandboxes fork from. The commit object is never on any branch and the
   * user's index/HEAD are untouched, so the editor sees nothing. Best-effort: a failure here just
   * leaves the base where it was (the next apply may then hit the old conflict, never corruption).
   */
  private async advanceBase(): Promise<void> {
    try {
      const root = this.deps.mainRoot;
      const tree = await writeWorkingTree(root);
      const git = createGit(root);
      const sha = (await git.raw(["commit-tree", tree, "-p", this.currentBase, "-m", "tend sandbox base"])).trim();
      await git.raw(["update-ref", SANDBOX_BASE_REF, sha]);
      this.currentBase = sha;
    } catch {
      /* keep the existing base; correctness is preserved, only the conflict-avoidance is skipped */
    }
  }

  /**
   * Tear down every sandbox (remove worktrees). Idempotent and concurrency-safe: the SIGINT
   * handler and the run's finally path may both call this at once, so all callers share — and
   * await — the same in-flight teardown. Without this, a second caller returning early would let
   * the signal handler's process.exit() race ahead and leak a worktree.
   */
  dispose(): Promise<void> {
    this.disposing ??= this.runDispose();
    return this.disposing;
  }

  private async runDispose(): Promise<void> {
    await this.queue.onIdle();
    await Promise.all([...this.sandboxes].map((sandbox) => sandbox.dispose()));
    this.idle.length = 0;
    this.sandboxes.clear();
  }

  private async acquire(): Promise<GitWorkerSandbox> {
    const existing = this.idle.pop();
    if (existing) return existing;
    const parent = this.deps.tempRoot ?? tmpdir();
    mkdirSync(parent, { recursive: true });
    const path = `${parent}/${WORKTREE_PREFIX}${process.pid}-${this.counter++}`;
    const mainGit = createGit(this.deps.mainRoot);
    await mainGit.raw(["worktree", "add", "--detach", path, this.currentBase]);
    const sandbox = new GitWorkerSandbox(path, { ...this.deps, exec: this.exec });
    this.sandboxes.add(sandbox);
    return sandbox;
  }
}

/** Paths of every worktree currently registered for the repo at `mainRoot`. */
async function registeredWorktrees(mainRoot: string): Promise<string[]> {
  const raw = await createGit(mainRoot).raw(["worktree", "list", "--porcelain"]);
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim());
}

/**
 * Self-heal after a crashed or cancelled prior run: force-remove any leftover `tend-worker-*`
 * worktrees still registered for `mainRoot`, then `git worktree prune` to clear stale admin
 * records. Best-effort and idempotent — never throws (a run must start even if cleanup hiccups).
 */
export async function pruneStaleWorktrees(mainRoot: string): Promise<void> {
  const git = createGit(mainRoot);
  try {
    for (const path of await registeredWorktrees(mainRoot)) {
      if (!basename(path).startsWith(WORKTREE_PREFIX)) continue;
      try {
        await git.raw(["worktree", "remove", "--force", path]);
      } catch {
        /* already gone or unremovable — fall through to filesystem cleanup + prune */
      }
      rmSync(path, { recursive: true, force: true });
    }
    await git.raw(["worktree", "prune"]);
  } catch {
    /* best-effort: never block the run on cleanup */
  }
}

export function mapOwnerRoot(mainRoot: string, mainOwnerRoot: string, sandboxRoot: string): string {
  const rel = normalizeRel(relative(mainRoot, mainOwnerRoot));
  return rel === "" ? sandboxRoot : `${sandboxRoot}/${rel}`;
}
