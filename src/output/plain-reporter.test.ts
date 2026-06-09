import { describe, expect, it } from "vitest";
import { detectOutputEnv } from "./env.js";
import type { TendEvent } from "./events.js";
import { PlainReporter } from "./plain-reporter.js";
import { makeTheme } from "./theme.js";

/** A plain reporter wired to a colorless theme, capturing every line it writes. */
function harness() {
  const lines: string[] = [];
  const env = detectOutputEnv({ stream: { isTTY: false }, env: {} });
  const reporter = new PlainReporter({ env, theme: makeTheme(env), write: (l) => lines.push(l) });
  return { reporter, lines };
}

describe("PlainReporter", () => {
  it("writes the wordmark on start and dim context notes after", () => {
    const { reporter, lines } = harness();
    reporter.start();
    reporter.note("snapshot saved · undo: tend undo");
    reporter.note("pnpm · TypeScript · vitest");
    expect(lines).toStrictEqual(["tend", "snapshot saved · undo: tend undo", "pnpm · TypeScript · vitest"]);
  });

  it("emits one plain line per meaningful event — no color, no spinner", () => {
    const { reporter, lines } = harness();
    const events: TendEvent[] = [
      { type: "scan-start", loop: 1 },
      { type: "scanner-start", loop: 1, tool: "jscpd" },
      { type: "scanner-result", loop: 1, tool: "jscpd", status: "ran", findings: 4 },
      { type: "audit", loop: 1, findings: 13, files: 10, scanned: 159 },
      { type: "loop-start", loop: 1, files: ["a.ts", "b.ts"], concurrency: 4, findings: 4 },
      { type: "file-start", loop: 1, file: "a.ts", rule: "cognitive-complexity", model: "claude-opus-4-6" },
      { type: "file-stage", loop: 1, file: "a.ts", stage: "typecheck" },
      { type: "file-result", loop: 1, file: "a.ts", outcome: "fixed", findings: 2 },
      { type: "file-result", loop: 1, file: "b.ts", outcome: "reverted", findings: 2, reason: "broke-test" },
      { type: "loop-complete", loop: 1, fixed: 1, reverted: 1, remaining: 0, estimatedCostUsd: 0.42 },
      { type: "done", exitStatus: 0 },
    ];
    for (const e of events) reporter.onEvent(e);

    // No ANSI escape codes anywhere.
    expect(lines.join("\n")).not.toMatch(new RegExp(String.fromCharCode(27)));
    expect(lines).toContain("initial audit: scanning…");
    expect(lines).toContain("scanner jscpd: running");
    expect(lines).toContain("scanner jscpd: ran 4 findings");
    expect(lines.some((l) => l.includes("initial audit: fix scope 159 files eligible for fixes") && l.includes("in-scope findings 13 across 10 files"))).toBe(true);
    expect(lines.some((l) => l.includes("fix pass 1") && l.includes("4 findings across 2 files") && l.includes("4 concurrent"))).toBe(true);
    expect(lines).toContain("progress a.ts: typecheck");
    // The fixed line shows the model the job ran on, verbatim.
    expect(lines.some((l) => l.includes("fixed a.ts") && l.includes("claude-opus-4-6"))).toBe(true);
    expect(lines.some((l) => l.includes("reverted b.ts") && l.includes("broke tests"))).toBe(true);
    // loop-complete now renders an intermediate summary line.
    expect(lines.some((l) => l.includes("loop 1:") && l.includes("1 fixed") && l.includes("1 reverted") && l.includes("$0.42"))).toBe(true);
    // file-start and done produce no standalone lines.
    expect(lines.some((l) => l.includes("a.ts") && l.includes("cognitive-complexity"))).toBe(false);
  });

  it("labels a deterministic-phase job's model as 'deterministic'", () => {
    const { reporter, lines } = harness();
    const events: TendEvent[] = [
      { type: "loop-start", loop: 1, files: ["a.ts"], concurrency: 1, findings: 1 },
      { type: "file-start", loop: 1, file: "a.ts", rule: "no-unused", model: "deterministic" },
      { type: "file-result", loop: 1, file: "a.ts", outcome: "fixed", findings: 1 },
    ];
    for (const e of events) reporter.onEvent(e);

    expect(lines.some((l) => l.includes("fixed a.ts") && l.includes("deterministic"))).toBe(true);
  });

  it("writes streamed session activity line-by-line during a long AI edit", () => {
    const { reporter, lines } = harness();
    const events: TendEvent[] = [
      { type: "file-stage", loop: 1, file: "a.ts", stage: "ai-edit" },
      { type: "file-stage", loop: 1, file: "a.ts", stage: "ai-edit", detail: "Read a.ts" },
      { type: "file-stage", loop: 1, file: "a.ts", stage: "ai-edit", detail: "Edit a.ts" },
    ];
    for (const e of events) reporter.onEvent(e);

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("\n")).not.toMatch(new RegExp(String.fromCharCode(27)));
    expect(lines.some((l) => l.includes("Read a.ts"))).toBe(true);
    expect(lines.some((l) => l.includes("Edit a.ts"))).toBe(true);
  });

  it("labels an unknown scanned-file count as a repo audit (whole-repo / --all)", () => {
    const { reporter, lines } = harness();
    reporter.onEvent({ type: "audit", loop: 1, findings: 3, files: 2 });
    expect(lines[0]).toContain("initial audit: fix scope whole repo");
    expect(lines[0]).toContain("in-scope findings 3 across 2 files");
  });

  it("run() resolves immediately (no async rendering in plain mode)", async () => {
    const { reporter } = harness();
    await expect(reporter.run()).resolves.toBeUndefined();
  });
});
