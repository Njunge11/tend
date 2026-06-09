import { describe, expect, it } from "vitest";
import { detectOutputEnv } from "./env.js";
import type { TendEvent } from "./events.js";
import { LiveReporter } from "./live-reporter.js";
import { makeTheme } from "./theme.js";

/** A live reporter with a colorless theme; listr runs its non-TTY fallback under vitest. */
function harness() {
  const lines: string[] = [];
  const env = detectOutputEnv({
    stream: { isTTY: true },
    env: {},
    noColor: true,
  });
  const reporter = new LiveReporter({
    env,
    theme: makeTheme(env),
    write: (l) => lines.push(l),
  });
  return { reporter, lines };
}

// A realistic one-loop run: scan → fix (one fixed, one reverted) → re-scan → done.
const ONE_LOOP: TendEvent[] = [
  { type: "scan-start", loop: 1 },
  { type: "audit", loop: 1, findings: 2, files: 2, scanned: 2 },
  {
    type: "loop-start",
    loop: 1,
    files: ["src/a.ts", "src/b.ts"],
    concurrency: 2,
    findings: 2,
  },
  {
    type: "file-start",
    loop: 1,
    file: "src/a.ts",
    rule: "cognitive-complexity",
    model: "claude-sonnet-4-6",
  },
  { type: "file-result", loop: 1, file: "src/a.ts", outcome: "fixed", findings: 1 },
  { type: "file-start", loop: 1, file: "src/b.ts", rule: "no-dupes", model: "claude-sonnet-4-6" },
  {
    type: "file-result",
    loop: 1,
    file: "src/b.ts",
    outcome: "reverted",
    findings: 1,
    reason: "broke-test",
  },
  { type: "loop-complete", loop: 1, fixed: 1, reverted: 1, remaining: 1, estimatedCostUsd: 0 },
  { type: "scan-start", loop: 2 },
  { type: "audit", loop: 2, findings: 1, files: 1, scanned: 2 },
  { type: "done", exitStatus: 0 },
];

describe("LiveReporter", () => {
  it("drives scan → fix → re-scan → done to completion without deadlocking", async () => {
    const { reporter, lines } = harness();
    reporter.start();
    const drawing = reporter.run();
    for (const e of ONE_LOOP) reporter.onEvent(e);
    reporter.close();

    await expect(drawing).resolves.toBeUndefined();
    expect(lines[0]).toBe("tend"); // header painted to our writer
  });

  it("winds down on close() even if `done` never arrives (orchestration threw)", async () => {
    const { reporter } = harness();
    reporter.start();
    const drawing = reporter.run();
    reporter.onEvent({ type: "scan-start", loop: 1 });
    // No audit, no done — simulate an early crash, then force the view to stop.
    reporter.close();

    await expect(drawing).resolves.toBeUndefined();
  });

  it("keeps completed-file output compact for large batches", async () => {
    const { reporter } = harness();
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      reporter.start();
      const drawing = reporter.run();
      reporter.onEvent({ type: "scan-start", loop: 1 });
      reporter.onEvent({
        type: "audit",
        loop: 1,
        findings: 150,
        files: 150,
        scanned: 150,
      });
      const files = Array.from({ length: 150 }, (_, i) => `src/file-${i}.ts`);
      reporter.onEvent({ type: "loop-start", loop: 1, files, concurrency: 8, findings: 150 });
      for (const file of files) {
        reporter.onEvent({
          type: "file-start",
          loop: 1,
          file,
          rule: "cognitive-complexity",
          model: "claude-sonnet-4-6",
        });
        reporter.onEvent({
          type: "file-result",
          loop: 1,
          file,
          outcome: "fixed",
          findings: 1,
        });
      }
      reporter.onEvent({ type: "loop-complete", loop: 1, fixed: 150, reverted: 0, remaining: 0, estimatedCostUsd: 0 });
      reporter.onEvent({ type: "done", exitStatus: 0 });
      reporter.close();
      await drawing;
    } finally {
      process.stdout.write = originalWrite;
    }

    const output = chunks.join("");
    expect(output).toContain("initial audit: fix scope 150 files eligible for fixes");
    expect(output).toContain("in-scope findings 150 across 150 files");
    expect(output).toContain("fix pass 1 · 150/150 fixed");
    expect(output).toContain("0 reverted");
    // Regression guard for captured terminals: fixed files should not be emitted as
    // persistent completed Listr rows, one per file, across redraws.
    expect(output.match(/file-\d+\.ts/g) ?? []).toHaveLength(0);
    expect(output.split("\n").length).toBeLessThan(25);
  });

  it("keeps the denominator stable when a job splits, counting findings not jobs", async () => {
    const { reporter } = harness();
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      reporter.start();
      const drawing = reporter.run();
      reporter.onEvent({ type: "scan-start", loop: 1 });
      reporter.onEvent({ type: "audit", loop: 1, findings: 2, files: 1, scanned: 1 });
      // One unit, two findings — the stable denominator.
      reporter.onEvent({ type: "loop-start", loop: 1, files: ["src/a.ts"], concurrency: 1, findings: 2 });
      reporter.onEvent({ type: "file-start", loop: 1, file: "src/a.ts", rule: "duplicate-code", model: "claude-opus-4-6" });
      // The multi-finding batch times out and is split: this is the split-parent placeholder
      // ("left", findings 0). It must NOT advance the denominator or any counter.
      reporter.onEvent({ type: "file-result", loop: 1, file: "src/a.ts", outcome: "left", findings: 0, reason: "regression" });

      // The split retries run as single-finding units; each one fixes one finding. The total
      // stays 2 even though three file-results landed for the one file.
      reporter.onEvent({ type: "file-start", loop: 1, file: "src/a.ts", rule: "duplicate-code", model: "claude-opus-4-6" });
      reporter.onEvent({ type: "file-stage", loop: 1, file: "src/a.ts", stage: "typecheck" });
      reporter.onEvent({ type: "file-result", loop: 1, file: "src/a.ts", outcome: "fixed", findings: 1 });
      reporter.onEvent({ type: "file-start", loop: 1, file: "src/a.ts", rule: "duplicate-code", model: "claude-opus-4-6" });
      reporter.onEvent({ type: "file-result", loop: 1, file: "src/a.ts", outcome: "fixed", findings: 1 });
      reporter.onEvent({ type: "loop-complete", loop: 1, fixed: 1, reverted: 1, remaining: 0, estimatedCostUsd: 0 });
      reporter.onEvent({ type: "scan-start", loop: 2 });
      reporter.onEvent({ type: "audit", loop: 2, findings: 0, files: 0, scanned: 1 });
      reporter.onEvent({ type: "done", exitStatus: 0 });
      reporter.close();
      await drawing;
    } finally {
      process.stdout.write = originalWrite;
    }

    const output = chunks.join("");
    // 2/2 fixed (not 3/3): the "left" placeholder was excluded and the denominator held.
    expect(output).toContain("fix pass 1 · 2/2 fixed");
  });

  it("excludes 'left' (not-attempted) findings from the live counts", async () => {
    const { reporter } = harness();
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      reporter.start();
      const drawing = reporter.run();
      reporter.onEvent({ type: "scan-start", loop: 1 });
      reporter.onEvent({ type: "audit", loop: 1, findings: 3, files: 2, scanned: 2 });
      reporter.onEvent({ type: "loop-start", loop: 1, files: ["src/a.ts", "src/b.ts"], concurrency: 2, findings: 3 });
      reporter.onEvent({ type: "file-start", loop: 1, file: "src/a.ts", rule: "no-dupes", model: "claude-sonnet-4-6" });
      reporter.onEvent({ type: "file-result", loop: 1, file: "src/a.ts", outcome: "fixed", findings: 1 });
      // A "left" with a non-zero finding count must still be ignored by the live counters.
      reporter.onEvent({ type: "file-start", loop: 1, file: "src/b.ts", rule: "no-dupes", model: "claude-sonnet-4-6" });
      reporter.onEvent({ type: "file-result", loop: 1, file: "src/b.ts", outcome: "left", findings: 2 });
      reporter.onEvent({ type: "loop-complete", loop: 1, fixed: 1, reverted: 0, remaining: 2, estimatedCostUsd: 0 });
      reporter.onEvent({ type: "scan-start", loop: 2 });
      reporter.onEvent({ type: "audit", loop: 2, findings: 2, files: 1, scanned: 2 });
      reporter.onEvent({ type: "done", exitStatus: 0 });
      reporter.close();
      await drawing;
    } finally {
      process.stdout.write = originalWrite;
    }

    const output = chunks.join("");
    // Only the one fixed finding counts; the 2 "left" findings are not folded in.
    expect(output).toContain("fix pass 1 · 1/3 fixed · 0 reverted");
  });
});
