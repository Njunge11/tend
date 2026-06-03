import { describe, expect, it, vi } from "vitest";
import type { RawFinding } from "../findings/normalize.js";
import {
  isAvailable,
  runScanner,
  scannerStatus,
  type Scanner,
  type ScanContext,
  type SpawnResult,
} from "./scanner.js";

const ctx: ScanContext = { cwd: "/repo", files: ["src/a.ts"], loop: 1 };

const rawFromSonar: RawFinding = {
  tool: "sonarjs",
  rule: "no-identical-expressions",
  category: "bug",
  severity: "error",
  file: "src/a.ts",
  range: { startLine: 1, startCol: 0, endLine: 1, endCol: 10 },
  message: "Identical sub-expressions",
};

function fakeScanner(overrides: Partial<Scanner> = {}): Scanner {
  return {
    tool: "sonarjs",
    binary: "eslint",
    buildArgs: () => ["--format", "json", "src/a.ts"],
    parse: () => [rawFromSonar],
    ...overrides,
  };
}

describe("isAvailable", () => {
  it("T-019: true when binary resolves", async () => {
    const which = vi.fn().mockResolvedValue(true);
    await expect(isAvailable(fakeScanner(), which)).resolves.toBe(true);
    expect(which).toHaveBeenCalledWith("eslint");
  });

  it("T-020: false when binary missing", async () => {
    const which = vi.fn().mockResolvedValue(false);
    await expect(isAvailable(fakeScanner(), which)).resolves.toBe(false);
  });
});

describe("runScanner", () => {
  it("T-021: run sequence calls availability → args → spawn → parse → normalize in order", async () => {
    const order: string[] = [];
    const which = vi.fn(async () => {
      order.push("availability");
      return true;
    });
    const spawn = vi.fn(async (): Promise<SpawnResult> => {
      order.push("spawn");
      return { stdout: "[]", stderr: "", exitCode: 0 };
    });
    const scanner = fakeScanner({
      buildArgs: () => {
        order.push("args");
        return [];
      },
      parse: () => {
        order.push("parse");
        return [rawFromSonar];
      },
    });

    const result = await runScanner(scanner, ctx, { which, spawn });

    expect(order).toStrictEqual(["availability", "args", "spawn", "parse"]);
    // normalize ran: a RawFinding became a Finding with an id + loop state
    expect(result.findings[0]?.id).toBeTypeOf("string");
    expect(result.findings[0]?.firstSeenLoop).toBe(1);
  });

  it("T-022: missing binary → scanner skipped (not fatal)", async () => {
    const which = vi.fn().mockResolvedValue(false);
    const spawn = vi.fn();

    const result = await runScanner(fakeScanner(), ctx, { which, spawn });

    expect(result.skipped).toBe(true);
    expect(result.findings).toStrictEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("T-023: non-zero exit but parseable output (e.g. eslint) → still parsed", async () => {
    const which = vi.fn().mockResolvedValue(true);
    const spawn = vi.fn(
      async (): Promise<SpawnResult> => ({ stdout: "<findings>", stderr: "", exitCode: 1 }),
    );

    const result = await runScanner(fakeScanner(), ctx, { which, spawn });

    expect(result.error).toBeUndefined();
    expect(result.findings).toHaveLength(1);
  });

  it("T-024: subprocess timeout → error result, run continues", async () => {
    const which = vi.fn().mockResolvedValue(true);
    const spawn = vi.fn(async () => {
      throw new Error("Command timed out after 30000ms");
    });

    const result = await runScanner(fakeScanner(), ctx, { which, spawn });

    expect(result.skipped).toBe(false);
    expect(result.error).toContain("timed out");
    expect(result.findings).toStrictEqual([]);
  });

  it("T-025: malformed JSON output → captured as error, no crash", async () => {
    const which = vi.fn().mockResolvedValue(true);
    const spawn = vi.fn(
      async (): Promise<SpawnResult> => ({ stdout: "{not json", stderr: "", exitCode: 0 }),
    );
    const scanner = fakeScanner({
      parse: (raw) => JSON.parse(raw.stdout) as RawFinding[],
    });

    const result = await runScanner(scanner, ctx, { which, spawn });

    expect(result.error).toBeDefined();
    expect(result.findings).toStrictEqual([]);
  });

  it("T-129: non-zero exit + unparseable stdout (crashed scanner) → stderr is the reason", async () => {
    const which = vi.fn().mockResolvedValue(true);
    // knip's real shape when its project config can't be loaded: exits non-zero, prints a
    // non-JSON banner to stdout, and the useful reason is on stderr.
    const spawn = vi.fn(
      async (): Promise<SpawnResult> => ({
        stdout: "Configuration file load error? Visit https://knip.dev/reference/known-issues",
        stderr: "ERROR: Error loading knip.config.ts\nReason: boom: cannot load project config",
        exitCode: 2,
      }),
    );
    const scanner = fakeScanner({ parse: (raw) => JSON.parse(raw.stdout) as RawFinding[] });

    const result = await runScanner(scanner, ctx, { which, spawn });

    expect(result.skipped).toBe(false);
    expect(result.findings).toStrictEqual([]);
    expect(result.error).toContain("cannot load project config"); // stderr, not the JSON.parse message
    expect(result.error).not.toContain("JSON");
  });
});

describe("scannerStatus", () => {
  it("T-130: derives ran / skipped / failed from a ScanResult", () => {
    expect(scannerStatus({ tool: "knip", findings: [], skipped: false })).toStrictEqual({
      tool: "knip",
      status: "ran",
    });
    expect(scannerStatus({ tool: "jscpd", findings: [], skipped: true })).toStrictEqual({
      tool: "jscpd",
      status: "skipped",
    });
    expect(
      scannerStatus({ tool: "knip", findings: [], skipped: false, error: "config blew up" }),
    ).toStrictEqual({ tool: "knip", status: "failed", reason: "config blew up" });
  });
});
