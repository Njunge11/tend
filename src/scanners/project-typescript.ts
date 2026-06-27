import { existsSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Resolve the `typescript` package entry that should drive a type-aware scan, preferring the
 * ANALYZED PROJECT's own install (resolved by walking up from `fromDir`) and falling back to a copy
 * resolvable from `fallbackFrom` (tend's bundled typescript). Returns the resolved main file, or
 * null when neither resolves.
 *
 * Why this exists: type-aware eslint-plugin-sonarjs rules read `ts.TypeFlags` bit values from
 * whatever `require("typescript")` resolves, while typescript-eslint builds the program with the
 * TypeScript its `projectService` loads. TypeScript 6.0 renumbered the `TypeFlags` enum, so when
 * those two are different versions the rules' `flags & TypeFlags.X` checks silently evaluate to 0 —
 * emitting phantom findings (e.g. `function-return-type` on every discriminated-union return) that no
 * source edit can clear. Binding BOTH to one instance keeps the bit values consistent.
 */
export function resolveProjectTypeScript(fromDir: string, fallbackFrom: string): string | null {
  // Anchor on a notional file in the directory so Node resolution walks up from there — matches
  // pnpm's strict layout, where typescript is reachable from a package dir but not the repo root.
  const attempt = (dir: string): string | null => {
    try {
      return createRequire(join(dir, "noop.js")).resolve("typescript");
    } catch {
      return null;
    }
  };
  return attempt(fromDir) ?? attempt(fallbackFrom);
}

type ResolveFilename = (request: string, parent: unknown, isMain: boolean, options?: unknown) => string;

/**
 * Force the WHOLE TypeScript-consuming toolchain to share one TypeScript install — the one whose main
 * file is `tsMainPath` (the project's, via {@link resolveProjectTypeScript}) — by redirecting both:
 *
 *  - the bare `require("typescript")` that eslint-plugin-sonarjs uses to read `TypeFlags`, AND
 *  - the `typescript/lib/*` SUBPATHS that typescript-eslint's `projectService` loads to build the
 *    program — chiefly `typescript/lib/tsserverlibrary`, which is a SEPARATE module from `typescript`
 *    and, left alone, resolves to a different (hoisted) TypeScript than the plugin's. That split is a
 *    known typescript-eslint/TypeScript issue (the "importing typescript twice" problem); redirecting
 *    the subpath to the project's copy makes its internal relative `require("./typescript.js")` land
 *    on the project's `typescript.js` too, so program and plugin agree on `TypeFlags` numbering.
 *
 * Subpaths are mapped to the project install's matching file (`<pkg>/lib/<sub>`, with a `.js` try) and
 * redirected only when that file exists — otherwise resolution falls through unchanged. Every other
 * module resolves normally. Returns an uninstaller that restores the original resolver.
 */
export function installTypeScriptResolutionHook(tsMainPath: string): () => void {
  // tsMainPath is `<pkg>/lib/typescript.js`; the package root is two directories up.
  const pkgRoot = dirname(dirname(tsMainPath));
  const mod = Module as unknown as { _resolveFilename: ResolveFilename };
  const original = mod._resolveFilename;
  mod._resolveFilename = function (this: unknown, request, parent, isMain, options): string {
    if (request === "typescript") return tsMainPath;
    if (request.startsWith("typescript/")) {
      const sub = request.slice("typescript/".length);
      for (const candidate of [join(pkgRoot, sub), join(pkgRoot, `${sub}.js`)]) {
        if (existsSync(candidate)) return candidate;
      }
    }
    return original.call(this, request, parent, isMain, options);
  } as ResolveFilename;
  return () => {
    mod._resolveFilename = original;
  };
}
