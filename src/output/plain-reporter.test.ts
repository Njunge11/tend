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
      { type: "audit", loop: 1, findings: 13, files: 10, scanned: 159 },
      { type: "loop-start", loop: 1, files: ["a.ts", "b.ts"], concurrency: 4 },
      { type: "file-start", loop: 1, file: "a.ts", rule: "cognitive-complexity" },
      { type: "file-result", loop: 1, file: "a.ts", outcome: "fixed" },
      { type: "file-result", loop: 1, file: "b.ts", outcome: "reverted", reason: "broke-test" },
      { type: "done", exitStatus: 0 },
    ];
    for (const e of events) reporter.onEvent(e);

    // No ANSI escape codes anywhere.
    expect(lines.join("\n")).not.toMatch(new RegExp(String.fromCharCode(27)));
    expect(lines).toContain("scanning…");
    expect(lines.some((l) => l.includes("scanned 159 files") && l.includes("13 findings") && l.includes("10 files"))).toBe(true);
    expect(lines.some((l) => l.includes("fixing loop 1") && l.includes("2 files") && l.includes("4 concurrent"))).toBe(true);
    expect(lines.some((l) => l.includes("fixed a.ts"))).toBe(true);
    expect(lines.some((l) => l.includes("reverted b.ts") && l.includes("broke tests"))).toBe(true);
    // file-start, loop-complete, done produce no standalone lines.
    expect(lines.some((l) => l.includes("a.ts") && l.includes("cognitive-complexity"))).toBe(false);
  });

  it("omits the scanned-file count when it is unknown (whole-repo / --all)", () => {
    const { reporter, lines } = harness();
    reporter.onEvent({ type: "audit", loop: 1, findings: 3, files: 2 });
    expect(lines[0]).toContain("3 findings");
    expect(lines[0]).not.toContain("files ·"); // no "N files ·" scanned prefix
  });

  it("run() resolves immediately (no async rendering in plain mode)", async () => {
    const { reporter } = harness();
    await expect(reporter.run()).resolves.toBeUndefined();
  });
});
