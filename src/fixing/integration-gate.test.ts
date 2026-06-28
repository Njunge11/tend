import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { tmpRepo, type TmpRepo } from "../../test/helpers/tmp-repo.js";
import { makeFinding } from "../../test/helpers/make-finding.js";
import { zeroUsage, type SessionRequest, type SessionResult, type SessionRunner } from "../session/types.js";
import { CAPABLE_MODEL } from "./model-selection.js";
import { snapshotUnitFiles } from "./unit-gate.js";
import { makeIntegrationGate, type IntegrationGateDeps } from "./fix-unit.js";
import type { WorkUnit } from "./dispatch.js";
import { WorkerSandboxPool } from "./worker-sandbox.js";

/**
 * End-to-end proof that the integrated acceptance gate makes parallel fixes LAND instead of being
 * reverted at the end. Same "combined break" the rollback test reproduces — two fixes that each
 * typecheck in isolation but together leave `a === b` with no type overlap (TS2367) — but here we
 * verify the integrated gate REPAIRS the integration in place so BOTH fixes stay landed, and only
 * drops a fix when repair genuinely can't.
 *
 * Real git (WorkerSandboxPool) + real tsc, no mocks. The "model" is a deterministic fake session
 * standing in for live AI (the goal explicitly allows a near-deterministic repro): on the LAND test
 * it reconciles the third file; on the DROP test it does nothing, forcing the revert path.
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

// Run tsc FROM the repo dir (as the real gate does from the owning package root) so diagnostic
// paths are repo-relative — what the integration gate parses for the editable-file set.
async function runTsc(dir: string): Promise<{ exitCode: number; output: string }> {
  const r = await execa("node", [TSC, "--noEmit"], { cwd: dir, reject: false });
  return { exitCode: r.exitCode ?? 1, output: `${r.stdout}\n${r.stderr}` };
}

async function patchFor(pool: WorkerSandboxPool, file: string, next: string): Promise<string> {
  return pool.withSandbox(unit(file), async (sandbox) => {
    writeFileSync(join(sandbox.cwd, file), next);
    const result = await sandbox.collectPatch(unit(file));
    if (!result.ok) throw new Error(result.detail);
    return result.patch;
  });
}

/** A SessionRunner whose run() invokes `edit` (writing the real tree) then reports success. */
function fakeSession(edit: (req: SessionRequest) => void): SessionRunner & { calls: number } {
  const session = {
    calls: 0,
    run: async (req: SessionRequest): Promise<SessionResult> => {
      session.calls += 1;
      edit(req);
      return { ok: true, edits: [], usage: zeroUsage() };
    },
  };
  return session;
}

function gateDeps(repoRoot: string, session: SessionRunner, ownerRoot = repoRoot): IntegrationGateDeps {
  return {
    cwd: repoRoot,
    ownerRoot,
    typescript: true,
    // tsc runs from the owning package root (as the real gate does), so diagnostics are owner-relative.
    runTsc: () => runTsc(ownerRoot),
    typecheckBaseline: [], // pristine tree is green, so any tsc error is NEW
    hasTestRunner: false,
    runRelated: async () => [],
    scanFindings: async () => [],
    baseline: new Set<string>(),
    session,
    maxRepairs: 3,
    repairModel: CAPABLE_MODEL,
    maxIntegrationRepairs: 1,
  };
}

async function setupCombinedBreak(): Promise<{ pool: WorkerSandboxPool; beforeFixB: Map<string, string | null> }> {
  const r = await tmpRepo();
  repo = r;
  r.write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, module: "esnext", moduleResolution: "bundler", skipLibCheck: true },
      include: ["*.ts"],
    }),
  );
  r.write("a.ts", "export const a: string | number = 'x';\n");
  r.write("b.ts", "export const b: string | number = 1;\n");
  r.write("compare.ts", "import { a } from './a';\nimport { b } from './b';\nexport const same: boolean = a === b;\n");
  await r.commit("initial (typechecks clean)");
  const snapshotSha = (await r.git.revparse(["HEAD"])).trim();
  expect((await runTsc(r.dir)).exitCode).toBe(0);

  const pool = new WorkerSandboxPool({
    mainRoot: r.dir,
    snapshotSha,
    maxSandboxes: 2,
    packageManager: "pnpm",
    prepareDependencies: false,
  });
  pools.push(pool);

  const patchA = await patchFor(pool, "a.ts", "export const a = 'x';\n");
  const patchB = await patchFor(pool, "b.ts", "export const b = 1;\n");

  // Fix A lands; base advances. Snapshot b.ts (still string|number) as the precise pre-fix-B revert
  // target, exactly as the orchestrator does before applyPatchToMain. Then fix B lands → TS2367.
  expect((await pool.applyPatchToMain(patchA, ["a.ts"])).ok).toBe(true);
  const beforeFixB = snapshotUnitFiles(r.dir, ["b.ts"]);
  expect((await pool.applyPatchToMain(patchB, ["b.ts"])).ok).toBe(true);

  const broken = await runTsc(r.dir);
  expect(broken.exitCode).not.toBe(0);
  expect(broken.output).toContain("TS2367");
  return { pool, beforeFixB };
}

describe.runIf(tscAvailable)("integrated acceptance gate (real tsc, combined break)", () => {
  it("repairs the integration in place so BOTH parallel fixes LAND, not reverted", async () => {
    const { beforeFixB } = await setupCombinedBreak();
    const dir = repo!.dir;

    // The model, handed the integration break, reconciles the THIRD file (compare.ts) rather than
    // touching either fix — the integration is the thing that's wrong, not fix A or fix B.
    const session = fakeSession((req) => {
      expect(req.model).toBe(CAPABLE_MODEL); // routed to the capable/Opus tier
      expect(req.prompt).toContain("compare.ts"); // editable set includes the error's file
      writeFileSync(
        join(dir, "compare.ts"),
        "import { a } from './a';\nimport { b } from './b';\nexport const same: boolean = String(a) === String(b);\n",
      );
    });

    const result = await makeIntegrationGate(gateDeps(dir, session))(unit("b.ts"), beforeFixB, zeroUsage());

    expect(session.calls).toBe(1);
    expect(result.kept).toBe(true);
    expect(result.repairedFiles).toContain("compare.ts");
    // BOTH fixes are still on disk — neither was reverted to land the other.
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("export const a = 'x';\n");
    expect(readFileSync(join(dir, "b.ts"), "utf8")).toBe("export const b = 1;\n");
    // And the combined tree compiles again.
    expect((await runTsc(dir)).exitCode).toBe(0);
  }, 60_000);

  it("drops only the offending fix when repair genuinely can't, keeping the rest", async () => {
    const { beforeFixB } = await setupCombinedBreak();
    const dir = repo!.dir;

    // The model fails to reconcile (writes nothing), so after the bounded retry the gate must drop
    // just fix B — restoring b.ts to its pre-fix content — and leave fix A landed.
    const session = fakeSession(() => {});

    const result = await makeIntegrationGate(gateDeps(dir, session))(unit("b.ts"), beforeFixB, zeroUsage());

    expect(session.calls).toBe(1); // one bounded repair attempt
    expect(result.kept).toBe(false);
    expect(result.reason).toBe("final-integration-failed");
    // Fix B reverted to its pre-fix content; fix A stays landed.
    expect(readFileSync(join(dir, "b.ts"), "utf8")).toBe("export const b: string | number = 1;\n");
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("export const a = 'x';\n");
    // With b widened again, `a === b` overlaps once more → the tree compiles.
    expect((await runTsc(dir)).exitCode).toBe(0);
  }, 60_000);

  it("maps owner-relative tsc paths to repo-relative editable files in a monorepo package", async () => {
    // The owning package lives under packages/app. tsc runs from THERE and emits `compare.ts`
    // (owner-relative), but the repair session edits from the repo root, where the file is
    // `packages/app/compare.ts`. The gate must hand the model the repo-relative path.
    const r = await tmpRepo();
    repo = r;
    const pkg = "packages/app";
    r.write(
      `${pkg}/tsconfig.json`,
      JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, module: "esnext", moduleResolution: "bundler", skipLibCheck: true },
        include: ["*.ts"],
      }),
    );
    // The combined break is already present on disk (both narrowed → `a === b` is TS2367).
    r.write(`${pkg}/a.ts`, "export const a = 'x';\n");
    r.write(`${pkg}/b.ts`, "export const b = 1;\n");
    r.write(`${pkg}/compare.ts`, "import { a } from './a';\nimport { b } from './b';\nexport const same: boolean = a === b;\n");
    await r.commit("monorepo package with a combined break");
    const ownerRoot = join(r.dir, pkg);
    expect((await runTsc(ownerRoot)).exitCode).not.toBe(0); // owner-root tsc sees TS2367

    const beforeFix = snapshotUnitFiles(r.dir, [`${pkg}/b.ts`]);
    const session = fakeSession((req) => {
      // The editable list and diagnostics name the REPO-relative path, not the bare owner-relative one.
      expect(req.prompt).toContain(`${pkg}/compare.ts`);
      expect(req.prompt).not.toMatch(/^- compare\.ts$/m);
      writeFileSync(
        join(r.dir, `${pkg}/compare.ts`),
        "import { a } from './a';\nimport { b } from './b';\nexport const same: boolean = String(a) === String(b);\n",
      );
    });

    const unitB: WorkUnit = {
      file: `${pkg}/b.ts`,
      files: [`${pkg}/b.ts`],
      findings: [makeFinding({ file: `${pkg}/b.ts` })],
      strategy: "single-file-ai-edit",
      strategies: ["single-file-ai-edit"],
    };
    const result = await makeIntegrationGate(gateDeps(r.dir, session, ownerRoot))(unitB, beforeFix, zeroUsage());

    expect(result.kept).toBe(true);
    expect(result.repairedFiles).toContain(`${pkg}/compare.ts`); // repo-relative, not "compare.ts"
    expect((await runTsc(ownerRoot)).exitCode).toBe(0);
  }, 60_000);
});
