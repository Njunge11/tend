import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFinding } from "../../test/helpers/make-finding.js";
import type { SessionResult, SessionRunner } from "../session/types.js";
import type { WorkUnit } from "./dispatch.js";
import { makeFixUnit, type FixUnitDeps } from "./fix-unit.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tend-fixunit-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (rel: string, contents: string): void => {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
};
const read = (rel: string): string => readFileSync(join(dir, rel), "utf8");

/**
 * A SessionRunner that edits files directly on disk — like `claude -p --allowedTools
 * Read,Write,Edit` does — then returns a scripted stream-json result that may or may
 * not reflect what it actually wrote.
 */
function diskSession(writes: Record<string, string>, result: SessionResult): SessionRunner {
  return {
    async run() {
      for (const [rel, contents] of Object.entries(writes)) write(rel, contents);
      return result;
    },
  };
}

function deps(session: SessionRunner, overrides: Partial<FixUnitDeps> = {}): FixUnitDeps {
  return {
    cwd: dir,
    session,
    typescript: false,
    runTsc: async () => ({ exitCode: 0, output: "" }),
    hasTestRunner: false,
    runRelated: async () => [],
    scanFindings: async () => [],
    baseline: new Set<string>(),
    maxRepairs: 3,
    ...overrides,
  };
}

const unit = (file: string): WorkUnit => ({
  file,
  files: [file],
  findings: [makeFinding({ file })],
});

describe("makeFixUnit — disk is the source of truth", () => {
  it("T-122: a session that edits disk but reports an error is reverted, not left applied", async () => {
    write("src/a.ts", "const x = a == b;\n");
    // claude writes a fix to disk, but its stream-json reads as an errored session
    const session = diskSession(
      { "src/a.ts": "const x = a === b;\n" },
      { ok: false, error: "boom", rateLimited: false },
    );

    const outcome = await makeFixUnit(deps(session))(unit("src/a.ts"));

    expect(outcome.kept).toBe(false);
    expect(outcome.detail).toBe("boom");
    // the on-disk edit must be reverted — never left applied for a later re-scan to call "fixed"
    expect(read("src/a.ts")).toBe("const x = a == b;\n");
  });

  it("T-123: a disk edit with empty stream-json edits still runs the gate (suppression caught + reverted)", async () => {
    write("src/a.ts", "const x = a == b;\n");
    // claude silenced the scanner with a suppression comment on disk, but reported no edits
    const session = diskSession(
      { "src/a.ts": "// eslint-disable-next-line\nconst x = a == b;\n" },
      { ok: true, edits: [] },
    );

    const outcome = await makeFixUnit(deps(session))(unit("src/a.ts"));

    expect(outcome.kept).toBe(false);
    expect(outcome.reason).toBe("suppression");
    expect(read("src/a.ts")).toBe("const x = a == b;\n");
  });

  it("T-124: a clean disk edit passes the gate and is kept (edits parse ignored)", async () => {
    write("src/a.ts", "const x = a == b;\n");
    const session = diskSession(
      { "src/a.ts": "const x = a === b;\n" },
      { ok: true, edits: [] }, // edits intentionally empty — the disk is the source of truth
    );

    const outcome = await makeFixUnit(deps(session))(unit("src/a.ts"));

    expect(outcome.kept).toBe(true);
    expect(read("src/a.ts")).toBe("const x = a === b;\n");
  });

  it("T-125: a session that changes nothing on disk is not a fix", async () => {
    write("src/a.ts", "const x = a == b;\n");
    const session = diskSession({}, { ok: true, edits: [] });

    const outcome = await makeFixUnit(deps(session))(unit("src/a.ts"));

    expect(outcome.kept).toBe(false);
    expect(outcome.detail).toBe("Session completed without changing owned files");
    expect(read("src/a.ts")).toBe("const x = a == b;\n");
  });

  it("records repair session failure detail when the repair window still fails", async () => {
    write("src/a.ts", "const x = a == b;\n");
    let runs = 0;
    const session: SessionRunner = {
      async run() {
        runs++;
        write("src/a.ts", "const x = a === b;\n");
        if (runs === 1) return { ok: true, edits: [] };
        return { ok: false, error: "repair timed out", rateLimited: false };
      },
    };
    const runRelated = vi.fn(async () => [{ name: "greenTest", status: "fail" as const }]);

    const outcome = await makeFixUnit(
      deps(session, {
        hasTestRunner: true,
        baseline: new Set(["greenTest"]),
        runRelated,
        maxRepairs: 1,
      }),
    )(unit("src/a.ts"));

    expect(outcome.kept).toBe(false);
    expect(outcome.reason).toBe("broke-test");
    expect(outcome.detail).toBe("Repair session failed: repair timed out");
  });

  it("sums estimated AI usage across the initial session and every repair session", async () => {
    write("src/a.ts", "const x = a == b;\n");
    // Each session run writes the same clean fix to disk and reports one session's usage.
    const perRun = {
      estimatedCostUsd: 0.01,
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 2,
      cacheReadInputTokens: 3,
      sessions: 1,
    };
    const session: SessionRunner = {
      async run() {
        write("src/a.ts", "const x = a === b;\n");
        return { ok: true, edits: [], usage: perRun };
      },
    };
    // A previously-green test is red on the first check, then green after one repair —
    // so the unit makes two session.run calls (initial + one repair).
    const outcomes: ("fail" | "pass")[] = ["fail", "pass"];
    const runRelated = vi.fn(async () => [
      { name: "t1", status: outcomes.shift() ?? "pass" } as const,
    ]);

    const outcome = await makeFixUnit(
      deps(session, { hasTestRunner: true, baseline: new Set(["t1"]), runRelated }),
    )(unit("src/a.ts"));

    expect(outcome.kept).toBe(true);
    // initial + one repair = two sessions, usage summed field-by-field
    expect(outcome.usage).toStrictEqual({
      estimatedCostUsd: 0.02,
      inputTokens: 20,
      outputTokens: 10,
      cacheCreationInputTokens: 4,
      cacheReadInputTokens: 6,
      sessions: 2,
    });
  });

  it("attributes usage even when the attempt is reverted (suppression caught)", async () => {
    write("src/a.ts", "const x = a == b;\n");
    const session: SessionRunner = {
      async run() {
        write("src/a.ts", "// eslint-disable-next-line\nconst x = a == b;\n");
        return {
          ok: true,
          edits: [],
          usage: {
            estimatedCostUsd: 0.05,
            inputTokens: 7,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            sessions: 1,
          },
        };
      },
    };

    const outcome = await makeFixUnit(deps(session))(unit("src/a.ts"));

    expect(outcome.kept).toBe(false);
    expect(outcome.reason).toBe("suppression");
    expect(outcome.usage?.estimatedCostUsd).toBe(0.05);
    expect(outcome.usage?.sessions).toBe(1);
  });

  it("reverts when a fix removes its finding but introduces a new one", async () => {
    write("src/a.ts", "const x = a == b;\n");
    const before = makeFinding({
      file: "src/a.ts",
      rule: "no-identical-expressions",
      message: "Identical sub-expressions",
      range: { startLine: 1, startCol: 0, endLine: 1, endCol: 10 },
    });
    const introduced = makeFinding({
      file: "src/a.ts",
      rule: "cognitive-complexity",
      message: "Function has too much cognitive complexity",
      range: { startLine: 2, startCol: 0, endLine: 2, endCol: 10 },
    });
    const scanFindings = vi.fn(async () => [introduced]);
    const session = diskSession(
      { "src/a.ts": "if (cond) {\n  doWork();\n}\n" },
      { ok: true, edits: [] },
    );
    const work: WorkUnit = { file: "src/a.ts", files: ["src/a.ts"], findings: [before] };

    const outcome = await makeFixUnit(deps(session, { scanFindings }))(work);

    expect(outcome.kept).toBe(false);
    expect(outcome.reason).toBe("regression");
    expect(scanFindings).toHaveBeenCalledWith(["src/a.ts"]);
    expect(read("src/a.ts")).toBe("const x = a == b;\n");
  });
});
