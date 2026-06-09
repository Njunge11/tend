import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChangeSet } from "../src/fixing/change-set.js";
import type { WorkUnit } from "../src/fixing/dispatch.js";
import { antiSuppression } from "../src/gate/checks/anti-suppression.js";
import { runTestPhase, type TestOutcome } from "../src/gate/checks/tests.js";
import { Snapshot } from "../src/git/snapshot.js";
import { normalize, type RawFinding } from "../src/findings/normalize.js";
import { orchestrate, type AuditResult, type FixOutcome } from "../src/orchestrator.js";
import type { SessionRunner } from "../src/session/types.js";
import { undoCommand } from "../src/commands/undo.js";
import { tmpRepo, type TmpRepo } from "./helpers/tmp-repo.js";

const config = { maxLoops: 5, perIssueBudget: 3, maxSessions: 4, model: "claude-sonnet-4-6" };
const LOOSE_EQ = /(?<![=!])==(?!=)/;

const codeFinding = (file: string): RawFinding => ({
  tool: "sonarjs",
  rule: "eqeqeq",
  category: "bug",
  severity: "error",
  file,
  range: { startLine: 1, startCol: 0, endLine: 1, endCol: 1 },
  message: "Expected === but found ==",
});

const secretFinding = (file: string): RawFinding => ({
  tool: "gitleaks",
  rule: "aws-key",
  category: "secret",
  severity: "error",
  file,
  range: { startLine: 1, startCol: 0, endLine: 1, endCol: 1 },
  message: "AWS access key",
});

let repo: TmpRepo;
beforeEach(async () => {
  repo = await tmpRepo();
});
afterEach(() => repo.cleanup());

const readRepo = (p: string) => readFileSync(join(repo.dir, p), "utf8");

/** A content scanner: flags any code file still containing loose equality. */
function auditFor(codeFiles: string[], secretFiles: string[] = []) {
  return async (): Promise<AuditResult> => {
    const findings = [
      ...codeFiles
        .filter((f) => LOOSE_EQ.test(readRepo(f)))
        .map((f) => normalize(codeFinding(f), 1)),
      ...secretFiles.map((f) => normalize(secretFinding(f), 1)),
    ];
    return { findings };
  };
}

/** Related test outcome for a unit: red if the file contains a BROKEN marker. */
async function runRelated(unit: WorkUnit): Promise<TestOutcome[]> {
  const content = readRepo(unit.file);
  return [{ name: `${unit.file}:test`, status: content.includes("BROKEN") ? "fail" : "pass" }];
}

/** Wire a realistic fixUnit: session → ChangeSet → anti-suppression → tests → keep/revert. */
function buildFixUnit(session: SessionRunner, baseline: Set<string>) {
  return async (unit: WorkUnit): Promise<FixOutcome> => {
    const before = readRepo(unit.file);
    const res = await session.run({ file: unit.file, findings: unit.findings, prompt: "fix" });
    if (!res.ok) return { kept: false, reason: "session-error" };

    const cs = new ChangeSet(res.edits);
    cs.apply();

    const after = readRepo(unit.file);
    const removed = before.split("\n").filter((l) => !after.includes(l)).map((l) => `-${l}`);
    const added = after.split("\n").filter((l) => !before.includes(l)).map((l) => `+${l}`);
    const supp = antiSuppression([...removed, ...added].join("\n"));
    if (!supp.ok) {
      cs.revert();
      return { kept: false, reason: supp.reason };
    }

    const phase = await runTestPhase({
      baseline,
      runRelated: () => runRelated(unit),
      repair: async () => {},
      maxRepairs: 0,
    });
    if (!phase.ok) {
      cs.revert();
      return { kept: false, reason: phase.reason };
    }
    return { kept: true };
  };
}

/** Session that writes fixed code (=== ) to each unit's file. */
const fixingSession: SessionRunner = {
  async run({ file, findings }) {
    void findings;
    const fixed = readFileSync(join(repo.dir, file), "utf8").replace(/==/g, "===");
    return { ok: true, edits: [{ path: join(repo.dir, file), contents: fixed }] };
  },
};

describe("loop integration (fixture repo + fake session)", () => {
  it("T-118: full loop — seeded issues → fixed → report", async () => {
    repo.write("src/a.ts", "const x = a == b;\n");
    await repo.commit("seed");

    const res = await orchestrate({
      audit: auditFor(["src/a.ts"]),
      fixUnit: buildFixUnit(fixingSession, new Set(["src/a.ts:test"])),
      config,
    });

    expect(res.termination).toBe("converged");
    expect(res.findings.find((f) => f.file === "src/a.ts")?.status).toBe("fixed");
    expect(readRepo("src/a.ts")).toContain("===");
  });

  it("T-119: a fix that breaks a test is reverted end-to-end", async () => {
    repo.write("src/b.ts", "const x = a == b;\n");
    await repo.commit("seed");
    const original = readRepo("src/b.ts");

    // session "fixes" the equality but injects a BROKEN marker that fails the test
    const breakingSession: SessionRunner = {
      async run({ file }) {
        return { ok: true, edits: [{ path: join(repo.dir, file), contents: "const x = a === b; // BROKEN\n" }] };
      },
    };

    const res = await orchestrate({
      audit: auditFor(["src/b.ts"]),
      fixUnit: buildFixUnit(breakingSession, new Set(["src/b.ts:test"])),
      config: { ...config, maxLoops: 2 },
    });

    // the breaking edit was reverted; the file is back to its original content
    expect(readRepo("src/b.ts")).toBe(original);
    expect(res.findings.find((f) => f.file === "src/b.ts")?.status).not.toBe("fixed");
  });

  it("T-120: secret in fixture → surfaced/halted, code fixes still proceed", async () => {
    repo.write("src/a.ts", "const x = a == b;\n");
    repo.write("config/prod.ts", "const key = 'AKIAIOSFODNN7EXAMPLE';\n");
    await repo.commit("seed");

    const res = await orchestrate({
      audit: auditFor(["src/a.ts"], ["config/prod.ts"]),
      fixUnit: buildFixUnit(fixingSession, new Set(["src/a.ts:test"])),
      config,
    });

    expect(res.secrets).toHaveLength(1);
    expect(res.exitStatus).toBe(1); // secrets make the run non-zero
    expect(res.findings.find((f) => f.file === "src/a.ts")?.status).toBe("fixed"); // code still fixed
    expect(readRepo("config/prod.ts")).toContain("AKIAIOSFODNN7EXAMPLE"); // secret never touched
  });

  it("T-121: undo restores the fixture repo exactly to pre-run state", async () => {
    repo.write("src/a.ts", "const x = a == b;\n");
    repo.write("src/c.ts", "const y = c == d;\n");
    await repo.commit("seed");

    const before = { a: readRepo("src/a.ts"), c: readRepo("src/c.ts") };
    const snap = await Snapshot.capture(repo.git, repo.dir);

    await orchestrate({
      audit: auditFor(["src/a.ts", "src/c.ts"]),
      fixUnit: buildFixUnit(fixingSession, new Set(["src/a.ts:test", "src/c.ts:test"])),
      config,
    });
    // sanity: the tool did change the files
    expect(readRepo("src/a.ts")).not.toBe(before.a);

    await undoCommand({ snapshot: snap, git: repo.git });

    expect(readRepo("src/a.ts")).toBe(before.a);
    expect(readRepo("src/c.ts")).toBe(before.c);
  });
});
