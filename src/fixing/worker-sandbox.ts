import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative } from "node:path";
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
  prepare(): Promise<void>;
  collectPatch(unit: WorkUnit): Promise<PatchResult>;
  dispose(): Promise<void>;
};

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
  private prepared = false;

  constructor(
    readonly cwd: string,
    private readonly deps: SandboxPoolDeps & { exec: Exec },
  ) {}

  async reset(): Promise<void> {
    const git = createGit(this.cwd);
    await git.raw(["reset", "--hard", this.deps.snapshotSha]);
    await git.raw(["clean", "-ffdx", ...cleanExcludes.flatMap((pattern) => ["-e", pattern])]);
  }

  async prepare(): Promise<void> {
    if (this.prepared || this.deps.prepareDependencies === false) return;
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
    this.prepared = true;
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
  private disposed = false;
  private readonly exec: Exec;

  constructor(private readonly deps: SandboxPoolDeps) {
    this.queue = new PQueue({ concurrency: deps.maxSandboxes });
    this.exec = (deps.exec ?? execa) as Exec;
  }

  async withSandbox<T>(run: (sandbox: WorkerSandbox) => Promise<T>): Promise<T> {
    return this.queue.add(async () => {
      let sandbox: GitWorkerSandbox;
      try {
        sandbox = await this.acquire();
      } catch (error) {
        throw new SandboxSetupError(error instanceof Error ? error.message : String(error));
      }
      try {
        await sandbox.reset();
        await sandbox.prepare();
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

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
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
    const path = `${parent}/tend-worker-${process.pid}-${this.counter++}`;
    const mainGit = createGit(this.deps.mainRoot);
    await mainGit.raw(["worktree", "add", "--detach", path, this.deps.snapshotSha]);
    const sandbox = new GitWorkerSandbox(path, { ...this.deps, exec: this.exec });
    this.sandboxes.add(sandbox);
    return sandbox;
  }
}

export function mapOwnerRoot(mainRoot: string, mainOwnerRoot: string, sandboxRoot: string): string {
  const rel = normalizeRel(relative(mainRoot, mainOwnerRoot));
  return rel === "" ? sandboxRoot : `${sandboxRoot}/${rel}`;
}
