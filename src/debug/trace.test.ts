import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTracer, type SessionTrace } from "./trace.js";

let traceDir: string;
beforeEach(() => {
  traceDir = mkdtempSync(join(tmpdir(), "tend-trace-"));
});
afterEach(() => rmSync(traceDir, { recursive: true, force: true }));

/** Subdirs of `traceDir` that are real per-run dirs (excludes the `latest` symlink). */
function runDirs(): string[] {
  return readdirSync(traceDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

const session = (file: string): SessionTrace => ({
  file,
  model: "m",
  effort: "high",
  prompt: "p",
  stdout: "{}",
  stderr: "",
  exitCode: 0,
  timedOut: false,
  durationMs: 1,
  findings: [],
});

describe("createTracer", () => {
  it("returns null when no trace dir is configured (tracing off)", () => {
    expect(createTracer(undefined)).toBeNull();
  });

  it("writes all files under a single per-run subdir, not the trace dir root", () => {
    const tracer = createTracer(traceDir);
    tracer?.event({ type: "debug", action: "terminal", detail: "give up" });
    tracer?.session(session("src/a.ts"));

    // Nothing lands directly in the trace dir root.
    expect(existsSync(join(traceDir, "events.jsonl"))).toBe(false);
    expect(existsSync(join(traceDir, "decisions.jsonl"))).toBe(false);

    const runs = runDirs();
    expect(runs).toHaveLength(1);
    const runDir = join(traceDir, runs[0] ?? "");
    expect(existsSync(join(runDir, "events.jsonl"))).toBe(true);
    expect(existsSync(join(runDir, "decisions.jsonl"))).toBe(true);
    expect(existsSync(join(runDir, "sessions", "001-src_a.ts"))).toBe(true);
  });

  it("keeps two runs into the same trace dir separate and non-interleaved", () => {
    const a = createTracer(traceDir);
    a?.event({ type: "debug", action: "run-a-decision" });
    a?.session(session("src/a.ts"));

    const b = createTracer(traceDir);
    b?.event({ type: "debug", action: "run-b-decision" });
    b?.session(session("src/b.ts"));

    const runs = runDirs();
    expect(runs).toHaveLength(2);

    // Each run's decisions.jsonl contains only its own events — no interleaving.
    const decisions = runs.map((r) => readFileSync(join(traceDir, r, "decisions.jsonl"), "utf8"));
    const aFile = decisions.find((d) => d.includes("run-a-decision"));
    const bFile = decisions.find((d) => d.includes("run-b-decision"));
    expect(aFile).toBeDefined();
    expect(bFile).toBeDefined();
    expect(aFile).not.toContain("run-b-decision");
    expect(bFile).not.toContain("run-a-decision");

    // Each run owns its own complete sessions dir; neither overwrites the other.
    const sessionDirs = runs.map((r) => readdirSync(join(traceDir, r, "sessions")));
    expect(sessionDirs.flat().sort()).toEqual(["001-src_a.ts", "001-src_b.ts"]);
  });

  it("points `latest` at the most recent run subdir", () => {
    createTracer(traceDir);
    const second = createTracer(traceDir);
    expect(second).not.toBeNull();

    const latest = join(traceDir, "latest");
    expect(existsSync(latest)).toBe(true);
    // `latest` resolves to a real run dir containing that run's trace files.
    second?.session(session("src/c.ts"));
    expect(existsSync(join(latest, "sessions", "001-src_c.ts"))).toBe(true);
  });
});
