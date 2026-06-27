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
  const dirs: string[] = [];
  const uninstallers: Array<() => void> = [];
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), "tend-tshook-"));
    dirs.push(d);
    return d;
  };
  const install = (path: string): void => {
    uninstallers.push(installTypeScriptResolutionHook(path));
  };
  afterEach(() => {
    while (uninstallers.length) (uninstallers.pop() as () => void)();
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  /**
   * A fake typescript install with the lib layout the real one has: `lib/typescript.js` (main) plus
   * `lib/tsserverlibrary.js` (the subpath typescript-eslint's projectService loads). Returns the
   * main path, which is what {@link installTypeScriptResolutionHook} is given.
   */
  function fakeTsInstall(): { main: string; tsserverlibrary: string } {
    const lib = join(tmp(), "typescript", "lib");
    mkdirSync(lib, { recursive: true });
    const main = join(lib, "typescript.js");
    const tsserverlibrary = join(lib, "tsserverlibrary.js");
    writeFileSync(main, "module.exports = {};");
    writeFileSync(tsserverlibrary, "module.exports = {};");
    return { main, tsserverlibrary };
  }

  it("redirects a bare `typescript` import to the pinned main", () => {
    const { main } = fakeTsInstall();
    expect(require_.resolve("typescript")).not.toBe(main);
    install(main);
    expect(require_.resolve("typescript")).toBe(main);
  });

  it("redirects the `typescript/lib/tsserverlibrary` subpath to the pinned install", () => {
    // This is the fix: projectService loads tsserverlibrary as a SEPARATE module, which otherwise
    // resolves to a different (hoisted) TypeScript than the plugin's bare `require("typescript")`.
    const { main, tsserverlibrary } = fakeTsInstall();
    install(main);
    expect(require_.resolve("typescript/lib/tsserverlibrary")).toBe(tsserverlibrary);
    expect(require_.resolve("typescript/lib/tsserverlibrary.js")).toBe(tsserverlibrary);
  });

  it("falls through for subpaths the pinned install doesn't have", () => {
    const { main } = fakeTsInstall(); // no lib/tsc.js
    install(main);
    expect(require_.resolve("typescript/package.json")).not.toBe(main);
    expect(() => require_.resolve("typescript/lib/does-not-exist")).toThrow();
  });

  it("leaves non-typescript modules unaffected", () => {
    const { main } = fakeTsInstall();
    install(main);
    expect(require_.resolve("node:path")).toBe("node:path");
    expect(require_.resolve("vitest")).not.toBe(main);
  });

  it("restores the original resolution when uninstalled", () => {
    const { main } = fakeTsInstall();
    const before = require_.resolve("typescript");
    const off = installTypeScriptResolutionHook(main);
    expect(require_.resolve("typescript")).toBe(main);
    off();
    expect(require_.resolve("typescript")).toBe(before);
  });
});
