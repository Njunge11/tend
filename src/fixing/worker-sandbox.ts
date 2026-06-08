import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

/** Prefix every tend sandbox worktree directory carries, so we can recognize our own. */
const WORKTREE_PREFIX = "tend-worker-";
import { execa, type Options as ExecaOptions } from "execa";
import PQueue from "p-queue";
import { createGit } from "../git/client.js";
import type { PackageManager } from "../detect/package-manager.js";
import type { WorkUnit } from "./dispatch.js";

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

export type ApplyPatchResult =
  | { ok: true }
  | { ok: false; reason: "patch-conflict"; detail: string };

export type WorkerSandbox = {
  readonly cwd: string;
  reset(): Promise<void>;
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

export function allowedPatchFiles(unit: WorkUnit): string[] {
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

  constructor(
    readonly cwd: string,
    private readonly deps: SandboxPoolDeps & { exec: Exec },
  ) {}

  async reset(): Promise<void> {
    const git = createGit(this.cwd);
    await git.raw(["reset", "--hard", this.deps.snapshotSha]);
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
        `sandbox dependency install failed: ${result.stderr || result.stdout || `exit ${result.exitCode ?? 1}`}`,
      );
    }
  }

  async collectPatch(unit: WorkUnit): Promise<PatchResult> {
    const git = createGit(this.cwd);
    const tracked = lines(await git.raw(["diff", "--name-only", this.deps.snapshotSha]));
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
    const patch = await git.raw(["diff", "--binary", this.deps.snapshotSha, "--", ...allowedFiles]);
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
  private readonly exec: Exec;

  constructor(private readonly deps: SandboxPoolDeps) {
    this.queue = new PQueue({ concurrency: deps.maxSandboxes });
    this.exec = (deps.exec ?? execa) as Exec;
  }

  async withSandbox<T>(unit: WorkUnit, run: (sandbox: WorkerSandbox) => Promise<T>): Promise<T> {
    return this.queue.add(async () => {
      let sandbox: GitWorkerSandbox;
      try {
        sandbox = await this.acquire();
      } catch (error) {
        throw new SandboxSetupError(error instanceof Error ? error.message : String(error));
      }
      try {
        await sandbox.reset();
        await sandbox.prepare(unit);
      } catch (error) {
        this.idle.push(sandbox);
        throw error instanceof SandboxSetupError
          ? error
          : new SandboxSetupError(error instanceof Error ? error.message : String(error));
      }
      try {
        return await run(sandbox);
      } finally {
        this.idle.push(sandbox);
      }
    }) as Promise<T>;
  }

  async applyPatchToMain(patch: string): Promise<ApplyPatchResult> {
    return this.applyQueue.add(async () => {
      if (patch.trim() === "") return { ok: true };
      const check = await this.exec("git", ["apply", "--check", "--3way"], {
        cwd: this.deps.mainRoot,
        input: patch,
        reject: false,
      });
      if ((check.exitCode ?? 1) !== 0) {
        return {
          ok: false,
          reason: "patch-conflict",
          detail: check.stderr || check.stdout || "git apply --check --3way failed",
        };
      }
      const applied = await this.exec("git", ["apply", "--3way"], {
        cwd: this.deps.mainRoot,
        input: patch,
        reject: false,
      });
      if ((applied.exitCode ?? 1) !== 0) {
        return {
          ok: false,
          reason: "patch-conflict",
          detail: applied.stderr || applied.stdout || "git apply --3way failed",
        };
      }
      return { ok: true };
    }) as Promise<ApplyPatchResult>;
  }

  /**
   * Tear down every sandbox (remove worktrees). Idempotent and concurrency-safe: the SIGINT
   * handler and the run's finally path may both call this at once, so all callers share — and
   * await — the same in-flight teardown. Without this, a second caller returning early would let
   * the signal handler's process.exit() race ahead and leak a worktree.
   */
  dispose(): Promise<void> {
    return (this.disposing ??= this.runDispose());
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
    await mainGit.raw(["worktree", "add", "--detach", path, this.deps.snapshotSha]);
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
