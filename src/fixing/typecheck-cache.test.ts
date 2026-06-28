import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { incrementalTscArgs, runIncrementalTsc, tscCacheFile } from "./typecheck-cache.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tend-tscache-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A fake `tsc` runner: records each invocation and writes the build-info file like real tsc. */
function fakeTsc(exitCode = 0) {
  const calls: { file: string; args: string[]; cwd?: string }[] = [];
  const exec = vi.fn(async (file: string, args: string[], options?: { cwd?: string }) => {
    calls.push({ file, args, cwd: options?.cwd });
    const flag = args.indexOf("--tsBuildInfoFile");
    const cacheFile = flag >= 0 ? args[flag + 1] : undefined;
    // Real tsc reuses an existing build-info file and rewrites it; mimic the write.
    const prior = cacheFile && existsSync(cacheFile) ? readFileSync(cacheFile, "utf8") : "";
    if (cacheFile) writeFileSync(cacheFile, `${prior}{"program":{}}`);
    return { stdout: "", stderr: "", exitCode };
  });
  return Object.assign(exec, { calls });
}

const FORBIDDEN_FLAGS = [
  "--skipLibCheck",
  "--strict",
  "--noImplicitAny",
  "--target",
  "--lib",
  "--module",
  "--moduleResolution",
  "--types",
  "--project",
  "-p",
];

describe("incrementalTscArgs", () => {
  it("requests an incremental --noEmit typecheck pointed at the given cache file", () => {
    const args = incrementalTscArgs("/cache/owner.tsbuildinfo");
    expect(args).toEqual([
      "tsc",
      "--noEmit",
      "--incremental",
      "--tsBuildInfoFile",
      "/cache/owner.tsbuildinfo",
    ]);
  });

  it("adds only caching flags — never a correctness or tsconfig-semantic flag", () => {
    const args = incrementalTscArgs("/cache/owner.tsbuildinfo");
    for (const flag of FORBIDDEN_FLAGS) expect(args).not.toContain(flag);
  });
});

describe("tscCacheFile", () => {
  it("places the cache file under the tend cache dir, not the consumer tree", () => {
    const cacheDir = join(dir, ".tend", "cache");
    const file = tscCacheFile(cacheDir, dir, dir);
    expect(file.startsWith(cacheDir)).toBe(true);
    expect(file.endsWith(".tsbuildinfo")).toBe(true);
  });

  it("lies outside a sandbox worktree, so it survives reset/clean", () => {
    // Cache dir is rooted at the MAIN repo; the owner runs inside a separate worktree.
    const mainRoot = join(dir, "main");
    const worktree = join(dir, "worktree-1");
    const cacheDir = join(mainRoot, ".tend", "cache");
    const file = tscCacheFile(cacheDir, mainRoot, join(worktree, "pkg"));
    expect(isAbsolute(file)).toBe(true);
    expect(relative(worktree, file).startsWith("..")).toBe(true);
  });

  it("gives monorepo packages distinct cache files", () => {
    const cacheDir = join(dir, ".tend", "cache");
    const root = tscCacheFile(cacheDir, dir, dir);
    const app = tscCacheFile(cacheDir, dir, join(dir, "packages", "app"));
    const lib = tscCacheFile(cacheDir, dir, join(dir, "packages", "lib"));
    expect(new Set([root, app, lib]).size).toBe(3);
  });

  it("is stable for the same owner across calls", () => {
    const cacheDir = join(dir, ".tend", "cache");
    const owner = join(dir, "packages", "app");
    expect(tscCacheFile(cacheDir, dir, owner)).toBe(tscCacheFile(cacheDir, dir, owner));
  });

  it("gives concurrent sandboxes of the same owner distinct cache files (no shared-file corruption)", () => {
    const cacheDir = join(dir, ".tend", "cache");
    const owner = join(dir, "packages", "app");
    const sandboxA = tscCacheFile(cacheDir, dir, owner, "/work/tend-sandbox-1");
    const sandboxB = tscCacheFile(cacheDir, dir, owner, "/work/tend-sandbox-2");
    expect(sandboxA).not.toBe(sandboxB);
    // ...but each sandbox's path is stable across iterations, so its cache stays warm.
    expect(tscCacheFile(cacheDir, dir, owner, "/work/tend-sandbox-1")).toBe(sandboxA);
    // and a discriminated path differs from the bare (serialized-consumer) path.
    expect(sandboxA).not.toBe(tscCacheFile(cacheDir, dir, owner));
  });
});

describe("runIncrementalTsc", () => {
  it("invokes tsc with the incremental cache file and creates the cache dir", async () => {
    const cacheDir = join(dir, ".tend", "cache");
    const cacheFile = tscCacheFile(cacheDir, dir, dir);
    const exec = fakeTsc(0);

    const result = await runIncrementalTsc({ exec, cwd: dir, cacheFile });

    expect(result).toEqual({ exitCode: 0, output: expect.any(String) });
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0]?.args).toContain("--incremental");
    expect(exec.calls[0]?.args).toContain("--tsBuildInfoFile");
    expect(exec.calls[0]?.args).toContain(cacheFile);
    expect(cacheFile.startsWith(cacheDir)).toBe(true);
    expect(existsSync(cacheFile)).toBe(true);
  });

  it("reuses the existing cache file on a second run (written once, present for the next)", async () => {
    const cacheDir = join(dir, ".tend", "cache");
    const cacheFile = tscCacheFile(cacheDir, dir, dir);
    const exec = fakeTsc(0);

    await runIncrementalTsc({ exec, cwd: dir, cacheFile });
    const afterFirst = readFileSync(cacheFile, "utf8");
    await runIncrementalTsc({ exec, cwd: dir, cacheFile });

    // Same path both times, and the second run saw the file the first one wrote.
    expect(exec.calls.every((c) => c.args.includes(cacheFile))).toBe(true);
    expect(readFileSync(cacheFile, "utf8").startsWith(afterFirst)).toBe(true);
    expect(readFileSync(cacheFile, "utf8").length).toBeGreaterThan(afterFirst.length);
  });

  it("still runs and reports the real pass/fail when the cache is corrupt", async () => {
    const cacheDir = join(dir, ".tend", "cache");
    const cacheFile = tscCacheFile(cacheDir, dir, dir);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cacheFile, "}{ corrupt not json");
    const exec = fakeTsc(2); // tsc reports type errors

    const result = await runIncrementalTsc({ exec, cwd: dir, cacheFile });

    expect(exec.calls).toHaveLength(1);
    expect(result.exitCode).toBe(2);
  });

  it("treats an undefined exit code (timeout/spawn failure) as a typecheck failure", async () => {
    const cacheDir = join(dir, ".tend", "cache");
    const cacheFile = tscCacheFile(cacheDir, dir, dir);
    const exec = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: undefined }));

    const result = await runIncrementalTsc({ exec, cwd: dir, cacheFile });
    expect(result.exitCode).toBe(1);
  });

  it("runs the project's resolved tsc via node — never `npx tsc`, which can run a registry decoy", async () => {
    // A resolvable `typescript` package in cwd (no exports field → subpath resolves off disk).
    mkdirSync(join(dir, "node_modules", "typescript", "bin"), { recursive: true });
    writeFileSync(
      join(dir, "node_modules", "typescript", "package.json"),
      JSON.stringify({ name: "typescript", version: "5.0.0" }),
    );
    writeFileSync(join(dir, "node_modules", "typescript", "bin", "tsc"), "#!/usr/bin/env node\n");
    const cacheFile = tscCacheFile(join(dir, ".tend", "cache"), dir, dir);
    const exec = fakeTsc(0);

    await runIncrementalTsc({ exec, cwd: dir, cacheFile });

    const call = exec.calls[0];
    expect(call?.file).toBe(process.execPath); // node, not npx
    // realpath may prefix /private on macOS, so match the suffix rather than the exact path.
    expect(call?.args[0]).toMatch(/[/\\]node_modules[/\\]typescript[/\\]bin[/\\]tsc$/);
    expect(call?.args).not.toContain("npx");
    expect(call?.args).toContain(cacheFile);
  });

  it("falls back to `npx --no-install` when typescript isn't resolvable (never auto-installs the decoy)", async () => {
    // dir has no typescript installed → can't resolve the real compiler.
    const cacheFile = tscCacheFile(join(dir, ".tend", "cache"), dir, dir);
    const exec = fakeTsc(0);

    await runIncrementalTsc({ exec, cwd: dir, cacheFile });

    const call = exec.calls[0];
    expect(call?.file).toBe("npx");
    expect(call?.args).toContain("--no-install"); // never `npx tsc` (which would fetch the decoy)
    expect(call?.args).toContain(cacheFile);
  });
});
