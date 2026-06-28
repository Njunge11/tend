import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { tmpRepo, type TmpRepo } from "../../test/helpers/tmp-repo.js";
import { makeFinding } from "../../test/helpers/make-finding.js";
import type { WorkUnit } from "./dispatch.js";
import { WorkerSandboxPool } from "./worker-sandbox.js";

/**
 * End-to-end proof of the final-integration rollback for the "combined break" class (the email
 * case): two fixes that EACH typecheck in isolation but break the integrated tree. Uses the real
 * WorkerSandboxPool (real git apply) and the real `tsc`, no mocks — applies both fixes, shows the
 * combined tree fails typecheck, then shows rollbackMainChanges restores a compiling tree.
 *
 * The break is engineered to be genuine: narrowing `a` to `string` (fix A) is fine while `b` is
 * still `string | number`; narrowing `b` to `number` (fix B) is fine while `a` is still
 * `string | number`; but with BOTH narrowings the unedited `a === b` in compare.ts has no type
 * overlap → TS2367 — the exact error class tend's per-unit gate cannot see across parallel sandboxes.
 */

const TSC = join(process.cwd(), "node_modules", "typescript", "bin", "tsc");
const tscAvailable = existsSync(TSC);

let repo: TmpRepo | undefined;
const pools: WorkerSandboxPool[] = [];

afterEach(async () => {
  await Promise.all(pools.map((pool) => pool.dispose()));
  pools.length = 0;
  repo?.cleanup();
  repo = undefined;
});

function unit(file: string): WorkUnit {
  return {
    file,
    files: [file],
    findings: [makeFinding({ file })],
    strategy: "single-file-ai-edit",
    strategies: ["single-file-ai-edit"],
  };
}

/** Run the project's tsc against the temp repo; returns the exit code + combined output. */
async function runTsc(dir: string): Promise<{ exitCode: number; output: string }> {
  const r = await execa("node", [TSC, "--noEmit", "--project", join(dir, "tsconfig.json")], {
    reject: false,
  });
  return { exitCode: r.exitCode ?? 1, output: `${r.stdout}\n${r.stderr}` };
}

/** Build a patch for `file` by writing `next` into a fresh sandbox and collecting the diff. */
async function patchFor(pool: WorkerSandboxPool, file: string, next: string): Promise<string> {
  return pool.withSandbox(unit(file), async (sandbox) => {
    writeFileSync(join(sandbox.cwd, file), next);
    const result = await sandbox.collectPatch(unit(file));
    if (!result.ok) throw new Error(result.detail);
    return result.patch;
  });
}

describe.runIf(tscAvailable)("final-integration rollback (real tsc, combined break)", () => {
  it("reverts two individually-clean fixes that together break typecheck, restoring a compiling tree", async () => {
    repo = await tmpRepo();
    repo.write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          module: "esnext",
          moduleResolution: "bundler",
          skipLibCheck: true,
        },
        include: ["*.ts"],
      }),
    );
    // Baseline: both a and b are `string | number`, so `a === b` overlaps and typechecks.
    repo.write("a.ts", "export const a: string | number = 'x';\n");
    repo.write("b.ts", "export const b: string | number = 1;\n");
    repo.write("compare.ts", "import { a } from './a';\nimport { b } from './b';\nexport const same: boolean = a === b;\n");
    await repo.commit("initial (typechecks clean)");
    const snapshotSha = (await repo.git.revparse(["HEAD"])).trim();

    expect((await runTsc(repo.dir)).exitCode).toBe(0); // baseline is green

    const pool = new WorkerSandboxPool({
      mainRoot: repo.dir,
      snapshotSha,
      maxSandboxes: 2,
      packageManager: "pnpm",
      prepareDependencies: false,
    });
    pools.push(pool);

    // Fix A narrows `a` to string; fix B narrows `b` to number. Each is built against the pristine
    // snapshot — exactly what two concurrent sandboxes do (neither sees the other's edit).
    const patchA = await patchFor(pool, "a.ts", "export const a = 'x';\n");
    const patchB = await patchFor(pool, "b.ts", "export const b = 1;\n");

    expect((await pool.applyPatchToMain(patchA, ["a.ts"])).ok).toBe(true);
    expect((await pool.applyPatchToMain(patchB, ["b.ts"])).ok).toBe(true);

    // Combined tree: `a` is string, `b` is number → `a === b` has no overlap → TS2367.
    const broken = await runTsc(repo.dir);
    expect(broken.exitCode).not.toBe(0);
    expect(broken.output).toContain("TS2367");

    // The final-integration gate's action: revert to the known-good baseline.
    const restored = pool.rollbackMainChanges();
    expect(restored).toEqual(["a.ts", "b.ts"]);

    // The tree compiles again, and the files are byte-identical to their pre-fix content.
    expect((await runTsc(repo.dir)).exitCode).toBe(0);
    expect(readFileSync(join(repo.dir, "a.ts"), "utf8")).toBe("export const a: string | number = 'x';\n");
    expect(readFileSync(join(repo.dir, "b.ts"), "utf8")).toBe("export const b: string | number = 1;\n");
  });
});
