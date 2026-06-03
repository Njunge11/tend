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
    expect(read("src/a.ts")).toBe("const x = a == b;\n");
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

    expect(outcome).toStrictEqual({ kept: false, reason: "regression" });
    expect(scanFindings).toHaveBeenCalledWith(["src/a.ts"]);
    expect(read("src/a.ts")).toBe("const x = a == b;\n");
  });
});
