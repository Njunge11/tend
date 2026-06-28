import { describe, expect, it } from "vitest";
import { expandWipFilesByImports } from "./wip-files.js";

/** Build an in-memory FS over repo-relative paths for deterministic, disk-free tests. */
function fakeFs(files: Record<string, string>, cwd = "/repo") {
  const abs = (rel: string) => `${cwd}/${rel}`;
  const byAbs = new Map(Object.entries(files).map(([rel, src]) => [abs(rel), src]));
  return {
    cwd,
    deps: {
      readFile: (p: string) => {
        const src = byAbs.get(p);
        if (src === undefined) throw new Error(`ENOENT ${p}`);
        return src;
      },
      exists: (p: string) => byAbs.has(p),
    },
  };
}

describe("expandWipFilesByImports", () => {
  it("follows an uncommitted file's relative imports into its private cluster (the admin tRPC case)", () => {
    const { cwd, deps } = fakeFs({
      "lib/trpc/client.tsx": `import { makeQueryClient } from "./query-client";\nimport type { AppRouter } from "./root";`,
      "lib/trpc/query-client.ts": `export const makeQueryClient = () => ({});`,
      "lib/trpc/root.ts": `export type AppRouter = unknown;`,
      "lib/trpc/server.tsx": `import type { AppRouter } from "./root";`,
      "lib/db/index.ts": `export const db = {};`,
    });

    const guarded = expandWipFilesByImports(["lib/trpc/client.tsx"], cwd, deps);

    // The kept WIP file's own imports are guarded so they can't be deleted out from under it.
    expect(guarded).toContain("lib/trpc/query-client.ts");
    expect(guarded).toContain("lib/trpc/root.ts");
    // A sibling the WIP file does NOT import is left deletable.
    expect(guarded).not.toContain("lib/trpc/server.tsx");
    expect(guarded).not.toContain("lib/db/index.ts");
  });

  it("resolves index files and various extensions, transitively", () => {
    const { cwd, deps } = fakeFs({
      "a.ts": `import { b } from "./feature";`,
      "feature/index.ts": `export { b } from "./b";`,
      "feature/b.tsx": `import "./c";\nexport const b = 1;`,
      "feature/c.ts": `export {};`,
    });

    const guarded = expandWipFilesByImports(["a.ts"], cwd, deps);

    expect(guarded).toEqual(
      expect.arrayContaining(["a.ts", "feature/index.ts", "feature/b.tsx", "feature/c.ts"]),
    );
  });

  it("ignores bare/package imports and unresolvable specifiers", () => {
    const { cwd, deps } = fakeFs({
      "x.ts": `import React from "react";\nimport { y } from "@scope/pkg";\nimport { z } from "./missing";`,
    });

    expect(expandWipFilesByImports(["x.ts"], cwd, deps)).toEqual(["x.ts"]);
  });

  it("terminates on import cycles", () => {
    const { cwd, deps } = fakeFs({
      "a.ts": `import "./b";`,
      "b.ts": `import "./a";`,
    });

    const guarded = expandWipFilesByImports(["a.ts"], cwd, deps);
    expect(new Set(guarded)).toEqual(new Set(["a.ts", "b.ts"]));
  });

  it("skips imports that resolve outside the repo root", () => {
    const { cwd, deps } = fakeFs({
      "pkg/a.ts": `import { shared } from "../../outside/shared";`,
      // note: ../../outside is above cwd; even if it existed it must not be guarded
    });
    expect(expandWipFilesByImports(["pkg/a.ts"], cwd, deps)).toEqual(["pkg/a.ts"]);
  });
});
