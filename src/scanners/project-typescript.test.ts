import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installTypeScriptResolutionHook, resolveProjectTypeScript } from "./project-typescript.js";

const require_ = createRequire(import.meta.url);

/** Write a minimal stand-in `typescript` package under `dir/node_modules` and return its main file. */
function fakeTypeScript(dir: string, version: string): string {
  const tsDir = join(dir, "node_modules", "typescript");
  mkdirSync(tsDir, { recursive: true });
  writeFileSync(join(tsDir, "package.json"), JSON.stringify({ name: "typescript", version, main: "index.js" }));
  writeFileSync(join(tsDir, "index.js"), `module.exports = { sentinel: ${JSON.stringify(version)} };`);
  return join(tsDir, "index.js");
}

describe("resolveProjectTypeScript", () => {
  const dirs: string[] = [];
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), "tend-projts-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  // Assert via the loaded module's sentinel rather than the resolved path string: macOS reports
  // tmp paths through the /private/var realpath, and which instance loads is the behaviour anyway.
  const sentinelOf = (resolved: string | null): unknown => require_(resolved as string).sentinel;

  it("resolves the project's own typescript in preference to the fallback", () => {
    const project = tmp();
    fakeTypeScript(project, "5.0.0-project");
    const fallback = tmp();
    fakeTypeScript(fallback, "9.9.9-fallback");

    expect(sentinelOf(resolveProjectTypeScript(project, fallback))).toBe("5.0.0-project");
  });

  it("falls back to the bundled typescript when the project ships none", () => {
    const projectWithoutTs = tmp();
    const fallback = tmp();
    fakeTypeScript(fallback, "9.9.9-fallback");

    expect(sentinelOf(resolveProjectTypeScript(projectWithoutTs, fallback))).toBe("9.9.9-fallback");
  });

  it("resolves typescript installed above the anchor directory (walks up)", () => {
    const project = tmp();
    fakeTypeScript(project, "5.0.0-project");
    const nested = join(project, "lib", "deep", "feature");
    mkdirSync(nested, { recursive: true });

    expect(sentinelOf(resolveProjectTypeScript(nested, tmp()))).toBe("5.0.0-project");
  });

  it("returns null when neither the project nor the fallback has typescript", () => {
    expect(resolveProjectTypeScript(tmp(), tmp())).toBeNull();
  });
});

describe("installTypeScriptResolutionHook", () => {
  const uninstallers: Array<() => void> = [];
  const install = (path: string): void => {
    uninstallers.push(installTypeScriptResolutionHook(path));
  };
  afterEach(() => {
    while (uninstallers.length) (uninstallers.pop() as () => void)();
  });

  const fakePath = "/somewhere/pinned/typescript/index.js";

  it("redirects a bare `typescript` import to the pinned path", () => {
    expect(require_.resolve("typescript")).not.toBe(fakePath);
    install(fakePath);
    expect(require_.resolve("typescript")).toBe(fakePath);
  });

  it("leaves other modules and typescript subpaths unaffected", () => {
    install(fakePath);
    expect(require_.resolve("node:path")).toBe("node:path");
    expect(require_.resolve("vitest")).not.toBe(fakePath);
    expect(require_.resolve("typescript/package.json")).not.toBe(fakePath);
  });

  it("restores the original resolution when uninstalled", () => {
    const before = require_.resolve("typescript");
    const off = installTypeScriptResolutionHook(fakePath);
    expect(require_.resolve("typescript")).toBe(fakePath);
    off();
    expect(require_.resolve("typescript")).toBe(before);
  });
});
