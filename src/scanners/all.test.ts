import { describe, expect, it, vi } from "vitest";
import { makeFinding } from "../../test/helpers/make-finding.js";
import type { ScanContext, ScanResult } from "./scanner.js";

const runEslintSonarjs = vi.hoisted(() =>
  vi.fn<(ctx: ScanContext) => Promise<ScanResult>>(),
);

vi.mock("./eslint-sonarjs.js", () => ({ runEslintSonarjs }));

import { buildAudit, scanFiles, scannerAvailability } from "./all.js";

describe("scannerAvailability", () => {
  it("keeps bundled sonarjs available when every external scanner binary is missing", async () => {
    const which = vi.fn(async () => false);

    const availability = await scannerAvailability(which);

    expect(availability.available).toStrictEqual(["sonarjs"]);
    expect(availability.missing).toStrictEqual([
      "knip",
      "jscpd",
      "semgrep",
      "osv-scanner",
      "gitleaks",
    ]);
    expect(availability.missing).not.toContain("eslint");
  });
});

describe("buildAudit", () => {
  it("T-124: scans exactly the injected scope and skips missing external scanners without marking all scanners missing", async () => {
    const sonarFinding = makeFinding({ tool: "sonarjs", file: "src/a.ts" });
    runEslintSonarjs.mockResolvedValueOnce({
      tool: "sonarjs",
      findings: [sonarFinding],
      skipped: false,
    });

    const which = vi.fn(async () => false);
    const spawn = vi.fn();
    const audit = buildAudit({
      cwd: "/repo",
      which,
      spawn,
      scope: ["src/a.ts"], // injected scope list, not derived from git
    });

    const result = await audit(1);

    expect(runEslintSonarjs).toHaveBeenCalledWith({
      cwd: "/repo",
      files: ["src/a.ts"],
      loop: 1,
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(result.allScannersMissing).toBe(false);
    expect(result.findings).toStrictEqual([sonarFinding]);
    expect(result.scanned).toBe(1);
    expect(result.scannerStatuses).toEqual(
      expect.arrayContaining([
        { tool: "sonarjs", status: "ran" },
        { tool: "knip", status: "skipped" },
        { tool: "jscpd", status: "skipped" },
        { tool: "semgrep", status: "skipped" },
        { tool: "osv", status: "skipped" },
        { tool: "gitleaks", status: "skipped" },
      ]),
    );
    runEslintSonarjs.mockReset();
  });

  it("a null scope scans the whole repo and leaves the scanned count generic", async () => {
    runEslintSonarjs.mockResolvedValueOnce({
      tool: "sonarjs",
      findings: [],
      skipped: false,
    });

    const audit = buildAudit({
      cwd: "/repo",
      which: vi.fn(async () => false),
      spawn: vi.fn(),
      scope: null, // whole-repo (the --all path)
    });

    await audit(1);

    expect(runEslintSonarjs).toHaveBeenCalledWith({
      cwd: "/repo",
      files: ["."],
      loop: 1,
    });
    runEslintSonarjs.mockReset();
  });
});

describe("scanFiles", () => {
  it("filters broad scanner output to the requested affected files", async () => {
    const inScope = makeFinding({ tool: "sonarjs", file: "src/a.ts" });
    const outOfScope = makeFinding({ tool: "sonarjs", file: "src/b.ts" });
    runEslintSonarjs.mockResolvedValueOnce({
      tool: "sonarjs",
      findings: [inScope, outOfScope],
      skipped: false,
    });

    const result = await scanFiles(
      {
        cwd: "/repo",
        which: async () => false,
        spawn: vi.fn(),
      },
      ["src/a.ts"],
      1,
    );

    expect(result.findings).toStrictEqual([inScope]);
    expect(result.scanned).toBe(1);
    runEslintSonarjs.mockReset();
  });
});
