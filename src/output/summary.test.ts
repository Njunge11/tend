import { describe, expect, it } from "vitest";
import { makeFinding } from "../../test/helpers/make-finding.js";
import { ReportBuilder } from "../report/builder.js";
import { groupRemaining, renderSummary } from "./summary.js";

function reportWith(...findings: ReturnType<typeof makeFinding>[]) {
  const builder = new ReportBuilder();
  builder.recordOutcomes(findings);
  return builder;
}

describe("renderSummary", () => {
  it("T-099: headline groups fixed vs couldn't-fix with real elapsed time", () => {
    const builder = reportWith(
      {
        ...makeFinding({ tool: "sonarjs", file: "src/a.ts" }),
        status: "fixed",
      },
      {
        ...makeFinding({
          tool: "knip",
          rule: "unused-export",
          category: "dead-code",
          file: "src/b.ts",
        }),
        status: "reverted",
        revertReason: "broke-test",
      },
    );
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

  it("surfaces each reverted finding per-file with its line, message, and revert reason", () => {
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
    expect(out).toContain("retryId");
    expect(out).toContain("line");
    expect(out).toContain("message");
    expect(out).toContain("command");
    expect(out).toContain("src/legacy/parse.ts");
    expect(out).toContain("142");
    expect(out).toContain("Refactor this function to reduce its cognitive complexity");
    expect(out).toContain("kx7p2q");
    expect(out).toContain("cognitive-complexity");
    expect(out).toContain("broke tests");
    expect(out).toContain("tend retry kx7p2q");
  });

  it("distinguishes same-rule findings in one file by line and message", () => {
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

    const out = renderSummary(report);

    expect(out).toContain("12");
    expect(out).toContain("47");
    expect(out).toContain("'token' is assigned a value but never used");
    expect(out).toContain("'session' is assigned a value but never used");
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
      ...makeFinding({
        tool: "knip",
        rule: "unused-export",
        category: "dead-code",
        file: "src/b.ts",
      }),
      retryId: "kx7p2q",
      status: "reverted",
      revertReason: "broke-test",
    });
    builder.recordScannerStatuses([{ tool: "knip", status: "ran" }]);
    const report = builder.build({ loops: 1, durationMs: 1000, exitStatus: 0 });

    const out = renderSummary(report, { plain: true });

    expect(out).toContain("summary fixed=0 couldntFix=1 skippedTests=0 reportOnly=0 left=0 secrets=0");
    expect(out).toContain("scanner tool=knip status=ran");
    expect(out).toContain('couldnt-fix retryId=kx7p2q file="src/b.ts"');
    expect(out).toContain('command="tend retry kx7p2q"');
    expect(out).toContain('next command="tend diff"');
    expect(out).not.toContain("┌");
    expect(out).not.toContain("│");
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
    const builder = reportWith(
      {
        ...makeFinding({ tool: "sonarjs", file: "src/a.ts" }),
        status: "fixed",
      },
      {
        ...makeFinding({
          tool: "knip",
          rule: "unused-export",
          category: "dead-code",
          file: "src/b.ts",
        }),
        status: "reverted",
      },
    );
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
      /sonarjs \(bundled\)\s+│ ✔ ran\s+│ in your changes\s+│ 2\s+│ 2/,
    );
    expect(out).toMatch(
      /jscpd\s+│ ✔ ran\s+│ in your changes\s+│ 1\s+│ 0\s+│ 0\s+│ 0\s+│ 0\s+│ 1/,
    );
    expect(out).toMatch(/knip\s+│ ✔ ran\s+│ in your changes\s+│ 0/); // clean scanner is explicit, never a vanished 0
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
    expect(out).not.toContain("repo-wide backlog");
    expect(out).not.toContain("outside your changes");
    expect(out).not.toContain("tend --all");
    expect(out).not.toContain("knip 2");
    // out-of-scope findings are NOT folded into the headline "left"
    expect(out).not.toMatch(/left 2/);
  });

  it("T-137: plain summary also omits out-of-scope backlog hints", () => {
    const builder = reportWith({
      ...makeFinding({
        tool: "knip",
        rule: "unused-export",
        category: "dead-code",
        file: "src/legacy.ts",
      }),
      status: "pending",
      inScope: false,
    });
    builder.recordScannerStatuses([{ tool: "knip", status: "ran" }]);
    const report = builder.build({ loops: 1, durationMs: 1000, exitStatus: 0 });

    const out = renderSummary(report, { plain: true });
    expect(out).not.toContain("repo-wide");
    expect(out).not.toContain("tend --all");
    expect(out).toContain("summary fixed=0 couldntFix=0 skippedTests=0 reportOnly=0 left=0 secrets=0");
  });

  it("renders pending report-only jscpd cross-file duplicates as report-only, not skipped tests", () => {
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
      status: "pending",
      inScope: true,
    });
    builder.recordScannerStatuses([{ tool: "jscpd", status: "ran" }]);
    const report = builder.build({ loops: 1, durationMs: 1000, exitStatus: 0 });

    const out = renderSummary(report);
    expect(out).toMatch(/skipped tests\s+│ – 0/);
    expect(out).toMatch(/report only\s+│ – 1/);
    expect(out).toMatch(/jscpd\s+│ ✔ ran\s+│ in your changes\s+│ 1\s+│ 0\s+│ 0\s+│ 0\s+│ 1\s+│ 0/);

    const plain = renderSummary(report, { plain: true });
    expect(plain).toContain("skippedTests=0 reportOnly=1 left=0");
    expect(plain).toContain('report-only count=1 reason="unsupported or report-only findings"');
    expect(plain).not.toContain("skipped-tests count=1");
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
    builder.recordScannerStatuses([{ tool: "jscpd", status: "ran" }]);
    const report = builder.build({ loops: 1, durationMs: 1000, exitStatus: 0 });

    const out = renderSummary(report);
    expect(out).toContain("skipped tests");
    expect(out).toContain("1 (pass --include-tests)");
    expect(out).toMatch(/left\s+│ – 0/);

    const plain = renderSummary(report, { plain: true });
    expect(plain).toContain("skippedTests=1 reportOnly=0 left=0");
    expect(plain).toContain('reason="test files are excluded by default"');
    expect(plain).toContain('command="tend run --include-tests <path...>"');
  });

  it("renders pending non-test AI-fix findings as left", () => {
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
    builder.recordScannerStatuses([{ tool: "sonarjs", status: "ran" }]);
    const report = builder.build({ loops: 1, durationMs: 1000, exitStatus: 0 });

    const out = renderSummary(report);
    expect(out).toMatch(/skipped tests\s+│ – 0/);
    expect(out).toMatch(/report only\s+│ – 0/);
    expect(out).toMatch(/left\s+│ – 1/);

    const plain = renderSummary(report, { plain: true });
    expect(plain).toContain("skippedTests=0 reportOnly=0 left=1");
  });

  it("--all scanner scope renders as whole repo, not in your changes", () => {
    const builder = reportWith({
      ...makeFinding({ tool: "sonarjs", file: "src/a.ts" }),
      status: "pending",
      inScope: true,
    });
    builder.recordScannerStatuses([{ tool: "sonarjs", status: "ran" }]);
    const report = builder.build({
      loops: 1,
      durationMs: 1000,
      exitStatus: 0,
      runScope: { type: "all" },
    });

    const out = renderSummary(report);
    expect(out).toContain("whole repo");
    expect(out).not.toContain("in your changes");

    const plain = renderSummary(report, { plain: true });
    expect(plain).toContain("scope=whole-repo");
    expect(plain).not.toContain("scope=in-your-changes");
  });

  it("non-zero exitStatus renders as needs attention, not completed", () => {
    const report = reportWith({
      ...makeFinding({ tool: "sonarjs", file: "src/a.ts" }),
      status: "fixed",
    }).build({ loops: 1, durationMs: 1000, exitStatus: 1 });

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
