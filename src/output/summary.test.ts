import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeFinding } from "../../test/helpers/make-finding.js";
import type { Finding } from "../findings/finding.js";
import { ReportBuilder } from "../report/builder.js";
import { ReportSchema, type Report } from "../report/schema.js";
import { auditEligibility, groupRemaining, renderSummary } from "./summary.js";

function reportWith(...findings: ReturnType<typeof makeFinding>[]) {
  const builder = new ReportBuilder();
  builder.recordOutcomes(findings);
  return builder;
}

/** Mark jscpd as ran, build a one-loop report, and render both the styled and plain summaries. */
function renderAfterJscpdRan(builder: ReportBuilder) {
  builder.recordScannerStatuses([{ tool: "jscpd", status: "ran" }]);
  const report = builder.build({ loops: 1, durationMs: 1000, exitStatus: 0 });
  return { out: renderSummary(report), plain: renderSummary(report, { plain: true }) };
}

/** Mark sonarjs as ran, build a one-loop report (with optional overrides), and render both summaries. */
function renderAfterSonarRan(
  builder: ReportBuilder,
  buildOverrides: Partial<Parameters<ReportBuilder["build"]>[0]> = {},
) {
  builder.recordScannerStatuses([{ tool: "sonarjs", status: "ran" }]);
  const report = builder.build({ loops: 1, durationMs: 1000, exitStatus: 0, ...buildOverrides });
  return { out: renderSummary(report), plain: renderSummary(report, { plain: true }) };
}

/** A knip `unused-export` dead-code finding for the given file. */
function knipDeadCodeFinding(file: string) {
  return makeFinding({
    tool: "knip",
    rule: "unused-export",
    category: "dead-code",
    file,
  });
}

/** A builder with one fixed sonarjs finding and one reverted knip dead-code finding. */
function fixedAndRevertedBuilder(revertReason?: Finding["revertReason"]) {
  return reportWith(
    {
      ...makeFinding({ tool: "sonarjs", file: "src/a.ts" }),
      status: "fixed",
    },
    {
      ...knipDeadCodeFinding("src/b.ts"),
      status: "reverted",
      ...(revertReason ? { revertReason } : {}),
    },
  );
}

/** A builder with a single sonarjs finding on src/a.ts at the given status (plus optional overrides). */
function sonarBuilder(status: Finding["status"], overrides: Partial<Finding> = {}) {
  return reportWith({ ...makeFinding({ tool: "sonarjs", file: "src/a.ts" }), status, ...overrides });
}

function badRunScopeAndTimeoutsReport(): Report {
  return ReportSchema.parse(
    JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../test/fixtures/reports/bad-run-scope-and-timeouts.json", import.meta.url)),
        "utf8",
      ),
    ),
  );
}

describe("renderSummary", () => {
  it("T-099: headline groups fixed vs couldn't-fix with real elapsed time", () => {
    const builder = fixedAndRevertedBuilder("broke-test");
    const report = builder.build({
      loops: 2,
      durationMs: 192_000,
      exitStatus: 0,
    });

    const out = renderSummary(report);

    expect(out).toContain("run summary");
    expect(out).toContain("fix passes");
    expect(out).not.toContain("│ loops");
    expect(out).toContain("fixed");
    expect(out).toContain("│ ✔ 1");
    expect(out).toContain("couldn't fix");
    expect(out).toContain("│ ↩ 1");
    expect(out).toContain("3m 12s"); // 192_000ms
  });

  it("renders a compact default couldn't-fix table and detailed retry table only in verbose mode", () => {
    const builder = reportWith({
      ...makeFinding({
        tool: "sonarjs",
        rule: "cognitive-complexity",
        file: "src/legacy/parse.ts",
        range: { startLine: 142, startCol: 0, endLine: 142, endCol: 10 },
        message: "Refactor this function to reduce its cognitive complexity",
      }),
      retryId: "kx7p2q",
      status: "reverted",
      revertReason: "broke-test",
    });
    const report = builder.build({ loops: 1, durationMs: 1000, exitStatus: 0 });

    const out = renderSummary(report);

    expect(out).toContain("couldn't fix");
    expect(out).toContain("reason");
    expect(out).toContain("count");
    expect(out).toContain("examples");
    expect(out).toContain("next action");
    expect(out).toContain("src/legacy/parse.ts");
    expect(out).toContain("test failed");
    expect(out).toContain("tend retry kx7p2q");
    expect(out).not.toContain("Refactor this function to reduce its cognitive complexity");
    expect(out).not.toContain("couldn't fix retry details");

    const verbose = renderSummary(report, { verbose: true });
    expect(verbose).toContain("couldn't fix retry details");
    expect(verbose).toContain("retryId");
    expect(verbose).toContain("line");
    expect(verbose).toContain("detail");
    expect(verbose).toContain("command");
    expect(verbose).not.toContain("message");
    expect(verbose).toContain("142");
    expect(verbose).toContain("kx7p2q");
    expect(verbose).toContain("cognitive-complexity");
    expect(verbose).toContain("tests failed");
  });

  it("verbose summary distinguishes same-rule findings in one file by line", () => {
    const builder = reportWith(
      {
        ...makeFinding({
          tool: "sonarjs",
          rule: "no-unused-vars",
          file: "src/signup.service.ts",
          range: { startLine: 12, startCol: 0, endLine: 12, endCol: 10 },
          message: "'token' is assigned a value but never used",
        }),
        retryId: "aaa111",
        status: "unfixable",
      },
      {
        ...makeFinding({
          tool: "sonarjs",
          rule: "no-unused-vars",
          file: "src/signup.service.ts",
          range: { startLine: 47, startCol: 0, endLine: 47, endCol: 10 },
          message: "'session' is assigned a value but never used",
        }),
        retryId: "bbb222",
        status: "unfixable",
      },
    );
    const report = builder.build({ loops: 1, durationMs: 1000, exitStatus: 0 });

    const out = renderSummary(report, { verbose: true });

    expect(out).toContain("12");
    expect(out).toContain("47");
    expect(out).toContain("aaa111");
    expect(out).toContain("bbb222");
  });

  it("ends with the next-step affordances", () => {
    const report = reportWith({ ...makeFinding(), status: "fixed" }).build({
      loops: 1,
      durationMs: 1000,
      exitStatus: 0,
    });

    const out = renderSummary(report);

    expect(out).toContain("next commands");
    expect(out).toContain("review edits");
    expect(out).toContain("tend diff");
    expect(out).toContain("stage deliberately");
    expect(out).toContain("git add -p");
    expect(out).toContain("undo run");
    expect(out).toContain("tend undo");
  });

  it("keeps --plain summary line-oriented for CI and pipes", () => {
    const builder = reportWith({
      ...knipDeadCodeFinding("src/b.ts"),
      retryId: "kx7p2q",
      status: "reverted",
      revertReason: "broke-test",
    });
    builder.recordScannerStatuses([{ tool: "knip", status: "ran" }]);
    const report = builder.build({ loops: 1, durationMs: 1000, exitStatus: 0 });

    const out = renderSummary(report, { plain: true });

    expect(out).toContain("summary fixed=0 couldntFix=1 skippedTests=0 reportOnly=0 secrets=0");
    // `unresolvedEligible=` is the single machine key for the left-over eligible bucket.
    expect(out).not.toMatch(/^summary .*\bleft=/m);
    expect(out).toContain("scanner tool=knip status=ran");
    expect(out).toContain('couldnt-fix retryId=kx7p2q file="src/b.ts"');
    expect(out).toContain('command="tend retry kx7p2q"');
    expect(out).toContain('next command="tend diff"');
    expect(out).not.toContain("┌");
    expect(out).not.toContain("│");
  });

  it("default summary with many failed findings renders grouped rows instead of every retryId", () => {
    const longMessage =
      "Refactor this function to reduce its cognitive complexity from 42 to the 15 allowed by the scanner because this long scanner message makes tables unreadable.";
    const findings = Array.from({ length: 50 }, (_, index) => ({
      ...makeFinding({
        tool: "sonarjs",
        rule: "cognitive-complexity",
        file: `src/feature-${index % 5}/very/deep/path/component-${index}.ts`,
        range: {
          startLine: index + 1,
          startCol: 0,
          endLine: index + 1,
          endCol: 10,
        },
        message: longMessage,
      }),
      retryId: `r${String(index).padStart(5, "0")}`,
      status: "unfixable" as const,
      revertReason: "session-error" as const,
    }));
    const report = reportWith(...findings).build({
      loops: 1,
      durationMs: 1000,
      exitStatus: 1,
    });

    const out = renderSummary(report);

    expect(out).toContain("session error");
    expect(out).toMatch(/session error\s+│ 50\s+│/);
    expect(out).toContain("run with --verbose");
    expect(out).not.toContain("r00000");
    expect(out).not.toContain("r00049");
    expect(out).not.toContain(longMessage);
    expect(out).not.toContain("cognitive-complexity");
  });

  it("default summary limits example files to 3 per reason", () => {
    const report = reportWith(
      ...[0, 1, 2, 3].map((index) => ({
        ...makeFinding({
          file: `src/example-${index}.ts`,
          message: `Finding ${index}`,
        }),
        retryId: `x${index}`,
        status: "unfixable" as const,
        revertReason: "typecheck" as const,
      })),
    ).build({ loops: 1, durationMs: 1000, exitStatus: 1 });

    const out = renderSummary(report);

    expect(out).toContain("src/example-0.ts");
    expect(out).toContain("src/example-1.ts");
    expect(out).toContain("src/example-2.ts");
    expect(out).not.toContain("src/example-3.ts");
  });

  it("renders session-error failures as timeout/session error with revert detail", () => {
    const builder = reportWith({
      ...makeFinding({
        tool: "sonarjs",
        rule: "complexity",
        file: "src/a.ts",
      }),
      retryId: "kx7p2q",
      status: "unfixable",
      revertReason: "session-error",
      finalFailureClass: "tool-timeout",
      revertDetail: "Claude session failed (exit 143)\nProcess was terminated",
    });
    const report = builder.build({ loops: 1, durationMs: 1000, exitStatus: 1 });

    const out = renderSummary(report);
    expect(out).toContain("timed out/session error");
    expect(out).toContain("session error");
    expect(out).not.toContain("Claude session failed (exit 143)");
    expect(out).not.toContain("exhausted retries");

    const verbose = renderSummary(report, { verbose: true });
    expect(verbose).toContain("timeout/session error");
    expect(verbose).toContain("Claude session failed (exit 143)");

    const plain = renderSummary(report, { plain: true });
    expect(plain).toContain('reason="timeout/session error"');
    expect(plain).toContain('detail="Claude session failed (exit 143)"');
  });

  it("renders regression, typecheck, and test failures with specific reasons", () => {
    const builder = reportWith(
      {
        ...makeFinding({ file: "src/regressed.ts" }),
        status: "unfixable",
        revertReason: "regression",
      },
      {
        ...makeFinding({ file: "src/typecheck.ts" }),
        status: "unfixable",
        revertReason: "typecheck",
      },
      {
        ...makeFinding({ file: "src/test-fail.ts" }),
        status: "unfixable",
        revertReason: "broke-test",
      },
    );
    const report = builder.build({ loops: 1, durationMs: 1000, exitStatus: 1 });

    const out = renderSummary(report);
    expect(out).toContain("regression");
    expect(out).toContain("typecheck failed");
    expect(out).toContain("test failed");
    expect(out).toMatch(/regressed\s+│ ↩ 1/);
    expect(out).toMatch(/typecheck failed\s+│ ↩ 1/);
    expect(out).toMatch(/test failed\s+│ ↩ 1/);

    const verbose = renderSummary(report, { verbose: true });
    expect(verbose).toContain("regression introduced");
    expect(verbose).toContain("tests failed");
  });

  it("renders estimated AI cost, sessions, and token rows", () => {
    const builder = reportWith({ ...makeFinding({ file: "src/a.ts" }), status: "fixed" });
    const report = builder.build({
      loops: 1,
      durationMs: 1000,
      exitStatus: 0,
      aiUsage: {
        estimatedCostUsd: 1.5,
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationInputTokens: 100,
        cacheReadInputTokens: 200,
        sessions: 4,
      },
    });

    const out = renderSummary(report);
    expect(out).toContain("estimated AI cost");
    expect(out).toContain("$1.50");
    expect(out).toContain("AI sessions");
    expect(out).toMatch(/AI sessions\s+│ 4/);
    expect(out).toContain("1000 in · 500 out · 200 cache read · 100 cache write");
  });

  it("shows $0.00 and 0 for a run with zero AI usage", () => {
    const report = reportWith({ ...makeFinding({ file: "src/a.ts" }), status: "fixed" }).build({
      loops: 1,
      durationMs: 1000,
      exitStatus: 0,
    });

    const out = renderSummary(report);
    expect(out).toContain("$0.00");
    expect(out).toMatch(/AI sessions\s+│ 0/);
  });

  it("renders estimated AI usage in the plain summary", () => {
    const report = reportWith({ ...makeFinding({ file: "src/a.ts" }), status: "fixed" }).build({
      loops: 1,
      durationMs: 1000,
      exitStatus: 0,
      aiUsage: {
        estimatedCostUsd: 1.23,
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationInputTokens: 100,
        cacheReadInputTokens: 200,
        sessions: 4,
      },
    });

    const out = renderSummary(report, { plain: true });
    expect(out).toContain("aiUsage estimatedCostUsd=1.23 sessions=4 inputTokens=1000 outputTokens=500");
    expect(out).toContain("cacheReadInputTokens=200 cacheCreationInputTokens=100");
  });

  it("celebrates when there is nothing to fix", () => {
    const report = reportWith().build({
      loops: 1,
      durationMs: 1000,
      exitStatus: 0,
    });
    expect(renderSummary(report)).toContain("nothing to fix");
  });

  it("summarizes scanners in a default table; exhaustive per-finding detail is verbose-only", () => {
    const builder = fixedAndRevertedBuilder();
    const report = builder.build({ loops: 2, durationMs: 3400, exitStatus: 0 });

    const out = renderSummary(report);
    expect(out).toContain("scanner breakdown");
    expect(out).toContain("sonarjs");
    expect(out).toContain("knip");
    expect(out).not.toContain("verbose findings");
    expect(renderSummary(report, { verbose: true })).toContain(
      "verbose findings",
    );
  });

  it("T-135: shows per-scanner in-scope counts for the developer's changes", () => {
    const builder = reportWith(
      {
        ...makeFinding({ tool: "sonarjs", file: "src/a.ts" }),
        status: "fixed",
      },
      {
        ...makeFinding({
          tool: "sonarjs",
          rule: "complexity",
          file: "src/c.ts",
        }),
        status: "fixed",
      },
      {
        ...makeFinding({
          tool: "jscpd",
          rule: "duplicate-code",
          category: "duplication",
          file: "src/d.ts",
        }),
        status: "pending",
      },
    );
    // knip ran clean (0 in-scope findings) — must still show "knip 0", not vanish
    builder.recordScannerStatuses([
      { tool: "sonarjs", status: "ran" },
      { tool: "jscpd", status: "ran" },
      { tool: "knip", status: "ran" },
    ]);
    const report = builder.build({ loops: 1, durationMs: 1000, exitStatus: 0 });

    const out = renderSummary(report);
    expect(out).toContain("in your changes");
    expect(out).toMatch(
      /sonarjs \(bundled\)\s+│ ✔ ran\s+│ 2\s+│ 2/,
    );
    expect(out).toMatch(
      /jscpd\s+│ ✔ ran\s+│ 1\s+│ 0\s+│ 0\s+│ 1/,
    );
    expect(out).toMatch(/knip\s+│ ✔ ran\s+│ 0/); // clean scanner is explicit, never a vanished 0
  });

  it("T-136: out-of-scope findings stay out of the default summary", () => {
    const builder = reportWith(
      {
        ...makeFinding({ tool: "sonarjs", file: "src/a.ts" }),
        status: "fixed",
        inScope: true,
      },
      {
        ...makeFinding({
          tool: "knip",
          rule: "unused-export",
          category: "dead-code",
          file: "src/legacy.ts",
        }),
        status: "pending",
        inScope: false,
      },
      {
        ...makeFinding({
          tool: "knip",
          rule: "unused-file",
          category: "dead-code",
          file: "src/old.ts",
        }),
        status: "pending",
        inScope: false,
      },
    );
    builder.recordScannerStatuses([
      { tool: "sonarjs", status: "ran" },
      { tool: "knip", status: "ran" },
    ]);
    const report = builder.build({ loops: 1, durationMs: 1000, exitStatus: 0 });

    const out = renderSummary(report);
    for (const absent of [
      "repo-wide backlog",
      "outside your changes",
      "tend --all",
      "knip 2",
    ]) {
      expect(out).not.toContain(absent);
    }
    // out-of-scope findings are NOT folded into the headline "left"
    expect(out).not.toMatch(/left 2/);
  });

  it("T-137: plain summary also omits out-of-scope backlog hints", () => {
    const builder = reportWith({
      ...knipDeadCodeFinding("src/legacy.ts"),
      status: "pending",
      inScope: false,
    });
    builder.recordScannerStatuses([{ tool: "knip", status: "ran" }]);
    const report = builder.build({ loops: 1, durationMs: 1000, exitStatus: 0 });

    const out = renderSummary(report, { plain: true });
    expect(out).not.toContain("repo-wide");
    expect(out).not.toContain("tend --all");
    expect(out).toContain("summary fixed=0 couldntFix=0 skippedTests=0 reportOnly=0 secrets=0");
  });

  it("renders pending report-only duplicates as report-only, not skipped tests", () => {
    const builder = reportWith({
      ...makeFinding({
        tool: "jscpd",
        rule: "duplicate-code",
        category: "duplication",
        file: "src/foo.test.ts",
        flowPath: [
          { file: "src/foo.test.ts", line: 1 },
          { file: "src/bar.ts", line: 1 },
        ],
      }),
      track: "report-only",
      status: "pending",
      inScope: true,
    });
    const { out, plain } = renderAfterJscpdRan(builder);
    // Zero exclusion rows are collapsed out of the run-summary table.
    expect(out).not.toContain("skipped tests");
    expect(out).toMatch(/report only\s+│ – 1/);
    // total 1 = fixed 0 + couldn't fix 0 + left 0 + excluded 1 (the report-only finding).
    expect(out).toMatch(/jscpd\s+│ ✔ ran\s+│ 1\s+│ 0\s+│ 0\s+│ 0\s+│ 1/);
    expect(plain).toContain("skippedTests=0 reportOnly=1 left=0");
    expect(plain).toContain('report-only count=1 reason="unsupported or report-only findings"');
    expect(plain).not.toContain("skipped-tests count=1");
  });

  it("buckets unsupported-strategy findings as report-only, not unresolved eligible", () => {
    // The dispatcher drops plans with strategy "unsupported" (e.g. a duplicate below the
    // refactor minimum) — the summary must not present them as eligible-but-unresolved.
    const builder = reportWith({
      ...makeFinding({
        tool: "jscpd",
        rule: "duplicate-code",
        category: "duplication",
        file: "src/git/repo.ts",
      }),
      status: "pending",
      inScope: true,
      repairStrategy: "unsupported",
      repairStrategyReason: "report-only",
    });
    const { out, plain } = renderAfterJscpdRan(builder);
    expect(out).toMatch(/report only\s+│ – 1/);
    expect(out).not.toContain("unresolved eligible");
    expect(plain).toContain("reportOnly=1");
    expect(plain).toContain("unresolvedEligible=0");
  });

  it("renders pending AI-fix test-file findings as skipped tests by default", () => {
    const builder = reportWith({
      ...makeFinding({
        tool: "jscpd",
        rule: "duplicate-code",
        category: "duplication",
        file: "src/foo.test.ts",
      }),
      status: "pending",
      inScope: true,
    });
    const { out, plain } = renderAfterJscpdRan(builder);
    expect(out).toContain("skipped tests");
    expect(out).toContain("1 (pass --include-tests)");
    expect(out).not.toContain("unresolved eligible"); // zero row collapsed
    expect(plain).toContain("skippedTests=1 reportOnly=0 left=0");
    expect(plain).toContain('reason="test files are excluded by default"');
    expect(plain).toContain('command="tend run --include-tests <path...>"');
  });

  it("shows generated, fixture, test, and out-of-scope exclusions separately", () => {
    const builder = reportWith(
      {
        ...makeFinding({ tool: "sonarjs", file: "dist/index.d.ts" }),
        status: "pending",
        inScope: true,
        inFixScope: false,
        scopeExclusionReason: "generated",
      },
      {
        ...makeFinding({ tool: "sonarjs", file: "test/fixtures/sample.ts" }),
        status: "pending",
        inScope: true,
        inFixScope: false,
        scopeExclusionReason: "fixtures",
      },
      {
        ...makeFinding({ tool: "sonarjs", file: "src/a.test.ts" }),
        status: "pending",
        inScope: true,
        inFixScope: false,
        scopeExclusionReason: "tests",
      },
      {
        ...makeFinding({ tool: "sonarjs", file: "src/outside.ts" }),
        status: "pending",
        inScope: false,
        inFixScope: false,
        scopeExclusionReason: "out-of-scope",
      },
    );
    const { out, plain } = renderAfterSonarRan(builder);
    expect(out).toMatch(/generated\s+│ – 1/);
    expect(out).toMatch(/fixtures\s+│ – 1/);
    expect(out).toMatch(/skipped tests\s+│ – 1/);
    // Repo-wide findings outside the scoped files say where they live, not just "out of scope".
    expect(out).toMatch(/elsewhere in repo \(outside fix scope\)\s+│ – 1/);
    expect(out).not.toContain("unresolved eligible"); // zero row collapsed
    expect(plain).toContain("skippedTests=1 reportOnly=0 secrets=0 generated=1 fixtures=1 outOfScope=1");
    expect(plain).toContain("generated count=1");
    expect(plain).toContain("fixtures count=1");
    expect(plain).toContain("out-of-scope count=1");
  });

  it("default scanner breakdown rows sum: total = fixed + couldn't fix + left + excluded", () => {
    const builder = reportWith(
      {
        ...makeFinding({ tool: "jscpd", rule: "duplicate-code", category: "duplication", file: "src/a.ts" }),
        status: "fixed",
        inScope: true,
      },
      {
        ...makeFinding({ tool: "jscpd", rule: "duplicate-code", category: "duplication", file: "src/b.test.ts" }),
        status: "pending",
        inScope: true,
        inFixScope: false,
        scopeExclusionReason: "tests",
      },
      {
        ...makeFinding({ tool: "jscpd", rule: "duplicate-code", category: "duplication", file: "src/c.ts" }),
        track: "report-only",
        status: "pending",
        inScope: true,
      },
    );
    const { out } = renderAfterJscpdRan(builder);
    expect(out).toContain("excluded");
    // total 3 = fixed 1 + couldn't fix 0 + left 0 + excluded 2 (1 test-skipped + 1 report-only).
    expect(out).toMatch(/jscpd\s+│ ✔ ran\s+│ 3\s+│ 1\s+│ 0\s+│ 0\s+│ 2/);

    // --verbose trades the rollup for the full per-bucket columns.
    builder.recordScannerStatuses([{ tool: "jscpd", status: "ran" }]);
    const verbose = renderSummary(builder.build({ loops: 1, durationMs: 1000, exitStatus: 0 }), { verbose: true });
    expect(verbose).not.toContain("excluded");
    expect(verbose).toMatch(/jscpd\s+│ ✔ ran\s+│ 3\s+│ 1\s+│ 0\s+│ 0\s+│ 1\s+│ 1\s+│ 0\s+│ 0\s+│ 0/);
  });

  it("renders pending non-test AI-fix findings as unresolved eligible", () => {
    const builder = reportWith({
      ...makeFinding({
        tool: "sonarjs",
        rule: "cognitive-complexity",
        category: "smell",
        file: "src/foo.ts",
      }),
      status: "pending",
      inScope: true,
    });
    const { out, plain } = renderAfterSonarRan(builder);
    expect(out).not.toContain("skipped tests"); // zero rows collapsed
    expect(out).not.toContain("report only");
    expect(out).toMatch(/unresolved eligible\s+│ – 1/);
    expect(plain).toContain("skippedTests=0 reportOnly=0 left=1");
    expect(plain).toContain("unresolvedEligible=1");
  });

  it("--all scanner scope renders as whole repo, not in your changes", () => {
    const builder = sonarBuilder("pending", { inScope: true });
    const { out, plain } = renderAfterSonarRan(builder, { runScope: { type: "all" } });
    expect(out).toContain("whole repo");
    expect(out).not.toContain("in your changes");
    expect(plain).toContain("scope=whole-repo");
    expect(plain).not.toContain("scope=in-your-changes");
  });

  it("surfaces the loop termination reason next to fix passes", () => {
    const builder = sonarBuilder("fixed");
    const { out, plain } = renderAfterSonarRan(builder, { termination: "max-loops" });
    expect(out).toMatch(/fix passes\s+│ 1 \(stopped: max loops reached\)/);
    expect(plain).toContain("termination=max-loops");
  });

  it("omits the termination label for reports written before termination tracking", () => {
    const builder = sonarBuilder("fixed");
    const { out, plain } = renderAfterSonarRan(builder);
    expect(out).toMatch(/fix passes\s+│ 1\s+│/);
    expect(out).not.toContain("stopped:");
    expect(plain).not.toContain("termination=");
  });

  it("non-zero exitStatus renders as needs attention, not completed", () => {
    const report = sonarBuilder("fixed").build({ loops: 1, durationMs: 1000, exitStatus: 1 });

    const out = renderSummary(report);
    expect(out).toContain("needs attention (exit 1)");
    expect(out).not.toContain("completed");
  });

  it("T-138: scanner-status line distinguishes ran / skipped / failed (with reason)", () => {
    const builder = reportWith({
      ...makeFinding({ tool: "sonarjs", file: "src/a.ts" }),
      status: "fixed",
    });
    builder.recordScannerStatuses([
      { tool: "sonarjs", status: "ran" },
      { tool: "semgrep", status: "skipped" },
      {
        tool: "knip",
        status: "failed",
        reason: "Error loading knip.config.ts\nReason: boom",
      },
    ]);
    const report = builder.build({ loops: 1, durationMs: 1000, exitStatus: 0 });

    const out = renderSummary(report);
    expect(out).toContain("scanner breakdown");
    expect(out).toContain("sonarjs (bundled)");
    expect(out).toContain("semgrep");
    expect(out).toMatch(/skipped.*not installed/);
    expect(out).toContain("knip");
    expect(out).toMatch(/knip.*failed/);
    expect(out).toContain("Error loading knip.config.ts"); // reason surfaced (first line)
    expect(out).not.toContain("Reason: boom"); // multi-line reason is trimmed to its first line
  });

  it("renders the bad scope/timeout regression fixture as actionable buckets", () => {
    const report = badRunScopeAndTimeoutsReport();

    const out = renderSummary(report);
    expect(out).toContain("needs attention (exit 1)");
    expect(out).toMatch(/timed out\/session error\s+│ ↩ 1/);
    expect(out).toMatch(/regressed\s+│ ↩ 1/);
    expect(out).toMatch(/skipped generated\s+│ – 1/);
    expect(out).toMatch(/skipped fixtures\s+│ – 1/);
    expect(out).toMatch(/report only\s+│ – 1/);
    expect(out).toMatch(/unresolved eligible\s+│ – 1/);
    expect(out).toContain("session error");
    expect(out).toMatch(/session error\s+│ 1\s+│ src\/workflows\/signup\.ts/);
    expect(out).toMatch(/regression\s+│ 1\s+│ src\/routes\/signup\.ts/);
    expect(out).not.toContain("Claude session failed (exit 143)");
    expect(out).not.toContain("exit status set without recorded blocking findings");

    const verbose = renderSummary(report, { verbose: true });
    expect(verbose).toContain("Claude session failed (exit 143)");
    expect(verbose).toMatch(/time01[\s\S]*src\/workflows\/signup\.ts[\s\S]*timeout\/session error/);
    expect(verbose).toMatch(/regr01[\s\S]*src\/routes\/signup\.ts[\s\S]*regression introduced/);

    const plain = renderSummary(report, { plain: true });
    expect(plain).toContain(
      "summary fixed=0 couldntFix=2 skippedTests=0 reportOnly=1 secrets=0 generated=1 fixtures=1 outOfScope=0 unresolvedEligible=1 timedOutSessionError=1 regressed=1",
    );
    expect(plain).toContain(
      "failureSummary blockingSecrets=0 unresolvedEligible=1 toolFailures=0 failedDeterministic=0 sessionErrors=1 regressions=1 typecheckFailures=0 testFailures=0",
    );
    // Scanner lines carry `left=` exactly once (the duplicate unresolvedEligible= alias is gone).
    expect(plain).not.toMatch(/^scanner [^\n]*unresolvedEligible=/m);
    expect(plain).toContain('couldnt-fix retryId=time01 file="src/workflows/signup.ts"');
    expect(plain).toContain('reason="timeout/session error" detail="Claude session failed (exit 143)"');
    expect(plain).not.toMatch(/retryId=time01[^\n]+reason="retries exhausted"/);
    expect(plain).toContain("generated count=1");
    expect(plain).toContain("fixtures count=1");
    expect(plain).toContain("report-only count=1");
  });
});

describe("auditEligibility", () => {
  /** A pending, in-scope sonarjs finding with the given overrides. */
  function pendingFinding(overrides: Partial<Finding> = {}): Finding {
    return {
      ...makeFinding({ tool: "sonarjs", file: "src/a.ts" }),
      status: "pending",
      inScope: true,
      ...overrides,
    };
  }

  it("does not count unsupported-strategy findings as eligible; buckets by planner reason", () => {
    const { eligible, excluded } = auditEligibility(
      [
        pendingFinding(), // genuinely dispatchable
        pendingFinding({ repairStrategy: "unsupported", repairStrategyReason: "report-only" }),
        pendingFinding({ repairStrategy: "unsupported", repairStrategyReason: "generated-source-not-found" }),
        pendingFinding({ repairStrategy: "unsupported", repairStrategyReason: "tests" }),
        pendingFinding({ repairStrategy: "unsupported", repairStrategyReason: "out-of-scope" }),
      ],
      false,
    );
    expect(eligible).toBe(1);
    expect(excluded).toStrictEqual({
      tests: 1,
      generated: 0,
      fixtures: 0,
      outOfScope: 1,
      reportOnly: 2,
    });
  });

  it("still counts dispatchable strategies as eligible", () => {
    const { eligible } = auditEligibility(
      [pendingFinding({ repairStrategy: "single-file-ai-edit" })],
      false,
    );
    expect(eligible).toBe(1);
  });
});

describe("groupRemaining", () => {
  it("T-100: remaining issues grouped by reason, ordered secrets → security → couldn't-fix → review", () => {
    const builder = reportWith(
      {
        ...makeFinding({
          tool: "gitleaks",
          rule: "aws-key",
          category: "secret",
          file: "config/prod.ts",
        }),
        status: "skipped",
      },
      {
        ...makeFinding({
          tool: "semgrep",
          rule: "sqli",
          category: "security",
          file: "src/api.ts",
        }),
        status: "reverted",
      },
      {
        ...makeFinding({
          tool: "sonarjs",
          rule: "complexity",
          category: "smell",
          file: "src/x.ts",
        }),
        status: "unfixable",
      },
    );
    builder.flagBehaviorChange({
      findingId: "z",
      file: "src/auth.ts",
      note: "assertion changed",
    });
    const report = builder.build({ loops: 3, durationMs: 100, exitStatus: 1 });

    const groups = groupRemaining(report);

    expect(groups.map((g) => g.key)).toStrictEqual([
      "secrets",
      "security",
      "couldnt-fix",
      "review",
    ]);
    expect(groups.every((g) => g.count === 1)).toBe(true);
  });
});
