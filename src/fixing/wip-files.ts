import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/**
 * Expand a seed set of "work-in-progress" files (the repo's uncommitted files — untracked or
 * modified) to include everything they import, transitively. Rationale: a half-finished file that
 * isn't wired up yet is flagged `unused-file` by knip, and so are the modules ONLY it imports (its
 * private cluster — a tRPC client/server/query-client trio, a feature's barrel + helpers). Deleting
 * those siblings while keeping the WIP file would break it; deleting the WIP file discards
 * in-progress work. Guarding the closure keeps a committed dependency from being deleted out from
 * under an uncommitted file that still imports it.
 *
 * Guarding the whole import closure is conservative-by-construction: the guard only ever SUPPRESSES
 * an `unused-file` deletion, so over-including a file that was genuinely deletable merely leaves it
 * reported instead of removed — it can never break anything. A file that's actually used elsewhere
 * wouldn't be flagged `unused-file` in the first place, so guarding it is a harmless no-op.
 *
 * Only relative specifiers are followed (a WIP file's own cluster lives beside it; bare/package
 * imports never point at deletion candidates). Resolution is best-effort across the usual TS/JS
 * extensions and index files; an unresolved import is simply skipped — the typecheck gate remains
 * the backstop for anything this misses.
 */
export function expandWipFilesByImports(
  seeds: readonly string[],
  cwd: string,
  deps: { readFile?: (abs: string) => string; exists?: (abs: string) => boolean } = {},
): string[] {
  const readFile = deps.readFile ?? ((abs: string) => readFileSync(abs, "utf8"));
  const exists = deps.exists ?? existsSync;

  const visited = new Set<string>(seeds);
  const queue = [...seeds];
  while (queue.length > 0) {
    const rel = queue.shift()!;
    let src: string;
    try {
      src = readFile(join(cwd, rel));
    } catch {
      continue; // unreadable (already deleted, binary, perms) → nothing to follow
    }
    const fromDir = dirname(join(cwd, rel));
    for (const spec of relativeImportSpecifiers(src)) {
      const resolvedAbs = resolveModule(join(fromDir, spec), exists);
      if (!resolvedAbs) continue;
      const resolvedRel = relative(cwd, resolvedAbs);
      if (resolvedRel.startsWith("..")) continue; // outside the repo → not a deletion candidate
      if (visited.has(resolvedRel)) continue;
      visited.add(resolvedRel);
      queue.push(resolvedRel);
    }
  }
  return [...visited];
}

// Relative specifiers in any import/export form that can point at a sibling deletion candidate:
//   import x from "./x"   ·   export { y } from "./y"   ·   import "./side-effect"
//   import("./dyn")       ·   require("./cjs")
// Bare specifiers ("react", "@scope/pkg") lack the leading ./ or ../ and are intentionally ignored.
const RELATIVE_IMPORT_RE =
  /(?:\bfrom|\bimport|\bexport|\brequire)\s*\(?\s*["'](\.\.?\/[^"']*)["']/g;

function relativeImportSpecifiers(src: string): string[] {
  const specs: string[] = [];
  for (const m of src.matchAll(RELATIVE_IMPORT_RE)) {
    if (m[1]) specs.push(m[1]);
  }
  return specs;
}

const MODULE_CANDIDATES = [
  "",
  ".ts",
  ".tsx",
  ".d.ts",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.jsx",
];

/** Resolve a relative import's base path to a real file across the usual TS/JS extensions. */
function resolveModule(basePath: string, exists: (abs: string) => boolean): string | undefined {
  for (const suffix of MODULE_CANDIDATES) {
    const candidate = `${basePath}${suffix}`;
    if (exists(candidate)) return candidate;
  }
  return undefined;
}
