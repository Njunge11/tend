import Module, { createRequire } from "node:module";
import { join } from "node:path";

/**
 * Resolve the `typescript` package entry that should drive a type-aware scan, preferring the
 * ANALYZED PROJECT's own install (resolved by walking up from `fromDir`) and falling back to a copy
 * resolvable from `fallbackFrom` (tend's bundled typescript). Returns the resolved main file, or
 * null when neither resolves.
 *
 * Why this exists: type-aware eslint-plugin-sonarjs rules read `ts.TypeFlags` bit values from
 * whatever `require("typescript")` resolves, while typescript-eslint builds the program with the
 * project's TypeScript. TypeScript 6.0 renumbered the `TypeFlags` enum, so when those two are
 * different versions the rules' `flags & TypeFlags.X` checks silently evaluate to 0 — emitting
 * phantom findings (e.g. `function-return-type` on every discriminated-union return) that no source
 * edit can clear. Binding both to ONE instance keeps the bit values consistent.
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
 * Force every bare `require("typescript")` to resolve to `tsMainPath`, so a package that loads its
 * own TypeScript (e.g. eslint-plugin-sonarjs) shares the one instance the program is built with.
 * Only the exact request `"typescript"` is redirected; subpaths (`typescript/bin/tsc`, …) and all
 * other modules resolve normally. Returns an uninstaller that restores the original resolver.
 */
export function installTypeScriptResolutionHook(tsMainPath: string): () => void {
  const mod = Module as unknown as { _resolveFilename: ResolveFilename };
  const original = mod._resolveFilename;
  mod._resolveFilename = function (this: unknown, request, parent, isMain, options): string {
    if (request === "typescript") return tsMainPath;
    return original.call(this, request, parent, isMain, options);
  } as ResolveFilename;
  return () => {
    mod._resolveFilename = original;
  };
}
