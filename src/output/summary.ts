import Table from "cli-table3";
import { TOOLS, type Finding, type Tool } from "../findings/finding.js";
import { isTestFile } from "../fixing/dispatch.js";
import type { Report } from "../report/schema.js";
import { formatDuration } from "./format.js";
import { makeTheme, type Theme } from "./theme.js";

const RULE_WIDTH = 49;

const PLAIN_THEME = makeTheme({
  color: false,
  interactive: false,
  unicode: true,
});

export type SummaryOptions = {
  theme?: Theme;
  verbose?: boolean;
  plain?: boolean;
};

type Buckets = {
  fixed: Finding[];
  skippedTests: Finding[]; // excluded by default unless --include-tests is passed
  generated: Finding[]; // generated/build/cache findings reported but excluded from AI fixes
  fixtures: Finding[]; // fixture findings reported but excluded from AI fixes
  outOfScope: Finding[]; // path/tooling scope findings reported but excluded from AI fixes
  reportOnly: Finding[]; // unsupported/report-only findings that tend did not attempt
  timedOutSessionError: Finding[];
  regressed: Finding[];
  typecheckFailed: Finding[];
  testFailed: Finding[];
  retryExhausted: Finding[];
  unresolvedEligible: Finding[]; // unresolved for reasons other than explicit exclusions/failures
  secrets: Finding[];
};

type PendingBucket =
  | "skippedTests"
  | "generated"
  | "fixtures"
  | "outOfScope"
  | "reportOnly"
  | "left";

/** A finding the developer can't read as part of their changes (scanned wide, out of scope). */
function isOutOfScope(f: Finding): boolean {
  return f.inScope === false && f.category !== "secret";
}

function bucket(report: Report): Buckets {
  const fixed: Finding[] = [];
  const skippedTests: Finding[] = [];
  const generated: Finding[] = [];
  const fixtures: Finding[] = [];
  const outOfScope: Finding[] = [];
  const reportOnly: Finding[] = [];
  const timedOutSessionError: Finding[] = [];
  const regressed: Finding[] = [];
  const typecheckFailed: Finding[] = [];
  const testFailed: Finding[] = [];
  const retryExhausted: Finding[] = [];
  const unresolvedEligible: Finding[] = [];
  const secrets: Finding[] = [];
  for (const f of report.findings) {
    if (f.category === "secret") secrets.push(f);
    // Out-of-scope findings are reported on the separate repo-wide line, never folded into
    // the headline counts — so "0 in your changes" can't read as "the repo is clean".
    else if (isOutOfScope(f)) outOfScope.push(f);
    else if (f.inReportScope === false) continue;
    else if (f.status === "fixed") fixed.push(f);
    else if (f.status === "reverted" || f.status === "unfixable") {
      if (f.revertReason === "session-error" || f.finalFailureClass === "tool-timeout") timedOutSessionError.push(f);
      else if (f.revertReason === "regression") regressed.push(f);
      else if (f.revertReason === "typecheck") typecheckFailed.push(f);
      else if (f.revertReason === "broke-test") testFailed.push(f);
      else retryExhausted.push(f);
    }
    else {
      const pending = classifyPending(f, report);
      if (pending === "skippedTests") skippedTests.push(f);
      else if (pending === "generated") generated.push(f);
      else if (pending === "fixtures") fixtures.push(f);
      else if (pending === "outOfScope") outOfScope.push(f);
      else if (pending === "reportOnly") reportOnly.push(f);
      else unresolvedEligible.push(f);
    }
  }
  return {
    fixed,
    skippedTests,
    generated,
    fixtures,
    outOfScope,
    reportOnly,
    timedOutSessionError,
    regressed,
    typecheckFailed,
    testFailed,
    retryExhausted,
    unresolvedEligible,
    secrets,
  };
}

function classifyPending(f: Finding, report: Report): PendingBucket {
  if (f.inFixScope === false) {
    if (f.scopeExclusionReason === "generated") return "generated";
    if (f.scopeExclusionReason === "fixtures") return "fixtures";
    if (f.scopeExclusionReason === "tests") return "skippedTests";
    return "outOfScope";
  }
  if (f.track === "report-only") return "reportOnly";
  if (
    f.track === "ai-fix" &&
    !report.fixPolicy.includeTests &&
    isTestFile(f.file)
  )
    return "skippedTests";
  return "left";
}

function couldntFixFindings(b: Buckets): Finding[] {
  return [
    ...b.timedOutSessionError,
    ...b.regressed,
    ...b.typecheckFailed,
    ...b.testFailed,
    ...b.retryExhausted,
  ];
}

/**
 * The final summary: a real headline (fixed / couldn't-fix / left / secrets + elapsed),
 * grouped by what the user must do, with revert reasons surfaced per file, and ending in
 * next-step affordances. Brief by default; `--verbose` adds the full per-finding listing.
 */
export function renderSummary(
  report: Report,
  opts: SummaryOptions = {},
): string {
  const theme = opts.theme ?? PLAIN_THEME;
  const { glyph } = theme;
  const b = bucket(report);
  if (opts.plain)
    return renderPlainSummary(report, b, theme, Boolean(opts.verbose));

  const lines: string[] = [];
  lines.push(theme.dim(glyph.rule.repeat(RULE_WIDTH)));
  lines.push(
    `done ${theme.dim(`${glyph.bullet} ${report.loops} fix passes ${glyph.bullet} ${formatDuration(report.durationMs)}`)}`,
  );
  lines.push("");
  lines.push(theme.bold("run summary"));
  lines.push(renderOverallTable(report, b, theme));

  lines.push("");
  lines.push(theme.bold("scanner breakdown"));
  lines.push(renderScannerBreakdownTable(report, theme));

  const couldntFix = couldntFixFindings(b);
  if (couldntFix.length > 0) {
    lines.push("");
    lines.push(theme.bold("couldn't fix"));
    lines.push(renderCouldntFixSummaryTable(couldntFix));
    if (opts.verbose) {
      lines.push("");
      lines.push(theme.bold("couldn't fix retry details"));
      lines.push(renderCouldntFixDetailTable(couldntFix, theme));
    }
  }

  if (b.secrets.length > 0) {
    lines.push("");
    lines.push(theme.bold("secrets"));
    lines.push(renderSecretsTable(b.secrets, theme));
  }

  if (opts.verbose) lines.push("", renderVerbose(report, theme));

  lines.push("");
  lines.push(theme.bold("next commands"));
  lines.push(renderNextCommandsTable());

  return lines.join("\n");
}

function renderPlainSummary(
  report: Report,
  b: Buckets,
  theme: Theme,
  verbose: boolean,
): string {
  const lines = [
    `done ${theme.glyph.bullet} ${report.loops} fix passes ${theme.glyph.bullet} ${formatDuration(report.durationMs)}`,
    [
      "summary",
      `fixed=${b.fixed.length}`,
      `couldntFix=${couldntFixFindings(b).length}`,
      `skippedTests=${b.skippedTests.length}`,
      `reportOnly=${b.reportOnly.length}`,
      `left=${b.unresolvedEligible.length}`,
      `secrets=${b.secrets.length}`,
      `generated=${b.generated.length}`,
      `fixtures=${b.fixtures.length}`,
      `outOfScope=${b.outOfScope.length}`,
      `unresolvedEligible=${b.unresolvedEligible.length}`,
      `timedOutSessionError=${b.timedOutSessionError.length}`,
      `regressed=${b.regressed.length}`,
      `typecheckFailed=${b.typecheckFailed.length}`,
      `testFailed=${b.testFailed.length}`,
    ].join(" "),
    [
      "aiUsage",
      `estimatedCostUsd=${report.aiUsage.estimatedCostUsd.toFixed(2)}`,
      `sessions=${report.aiUsage.sessions}`,
      `inputTokens=${report.aiUsage.inputTokens}`,
      `outputTokens=${report.aiUsage.outputTokens}`,
      `cacheReadInputTokens=${report.aiUsage.cacheReadInputTokens}`,
      `cacheCreationInputTokens=${report.aiUsage.cacheCreationInputTokens}`,
    ].join(" "),
  ];
  const strategyCounts = repairStrategyCounts(report);
  if (strategyCounts.size > 0) {
    lines.push(
      [
        "repairStrategies",
        ...[...strategyCounts.entries()].map(([strategy, count]) => `${strategy}=${count}`),
      ].join(" "),
    );
  }
  if (report.exitStatus !== 0 || hasFailureSummary(report)) {
    lines.push(
      [
        "failureSummary",
        `blockingSecrets=${report.failureSummary.blockingSecrets}`,
        `unresolvedEligible=${report.failureSummary.unresolvedEligible}`,
        `toolFailures=${report.failureSummary.toolFailures}`,
        `failedDeterministic=${report.failureSummary.failedDeterministic}`,
        `sessionErrors=${report.failureSummary.sessionErrors}`,
        `regressions=${report.failureSummary.regressions}`,
        `typecheckFailures=${report.failureSummary.typecheckFailures}`,
      `testFailures=${report.failureSummary.testFailures}`,
      `sandboxSetupFailures=${report.failureSummary.sandboxSetupFailures}`,
      `patchConflicts=${report.failureSummary.patchConflicts}`,
      `unownedPatches=${report.failureSummary.unownedPatches}`,
      `finalIntegrationFailures=${report.failureSummary.finalIntegrationFailures}`,
    ].join(" "),
  );
  if (report.finalIntegration && !report.finalIntegration.ok) {
    lines.push(
      `final-integration status=failed files=${report.finalIntegration.files.length} detail=${JSON.stringify(firstLine(report.finalIntegration.detail ?? ""))}`,
    );
  }
  }

  const counts = inScopeByTool(report);
  const statusByTool = new Map(report.scannerStatuses.map((s) => [s.tool, s]));
  const tools = TOOLS.filter((t) => statusByTool.has(t) || counts.has(t));
  for (const tool of tools) {
    const status = statusByTool.get(tool);
    const c = counts.get(tool) ?? {
      total: 0,
      fixed: 0,
      couldntFix: 0,
      skippedTests: 0,
      reportOnly: 0,
      left: 0,
      generated: 0,
      fixtures: 0,
      outOfScope: 0,
    };
    const reason =
      status?.status === "failed" && status.reason
        ? ` reason=${JSON.stringify(firstLine(status.reason))}`
        : status?.status === "skipped"
          ? " reason=not-installed"
          : "";
    lines.push(
      `scanner tool=${tool} status=${status?.status ?? "not-recorded"} scope=${plainScopeLabel(report)} total=${c.total} fixed=${c.fixed} couldntFix=${c.couldntFix} skippedTests=${c.skippedTests} reportOnly=${c.reportOnly} left=${c.left} unresolvedEligible=${c.left} generated=${c.generated} fixtures=${c.fixtures} outOfScope=${c.outOfScope}${reason}`,
    );
  }

  for (const f of couldntFixFindings(b)) {
    const id = retryTarget(f);
    lines.push(
      `couldnt-fix retryId=${f.retryId ?? "(none)"} file=${JSON.stringify(f.file)} rule=${JSON.stringify(f.rule)} reason=${JSON.stringify(findingReason(f))} detail=${JSON.stringify(firstLine(f.revertDetail ?? ""))} command=${JSON.stringify(`tend retry ${id}`)}`,
    );
  }

  for (const f of b.secrets) {
    lines.push(
      `secret retryId=${f.retryId ?? "(none)"} file=${JSON.stringify(f.file)} rule=${JSON.stringify(f.rule)} action=${JSON.stringify("rotate + scrub history")}`,
    );
  }

  if (b.skippedTests.length > 0) {
    lines.push(
      `skipped-tests count=${b.skippedTests.length} reason="test files are excluded by default" command="tend run --include-tests <path...>"`,
    );
  }

  if (b.generated.length > 0) {
    lines.push(
      `generated count=${b.generated.length} reason="generated/cache/build output is excluded from fixes by default"`,
    );
  }

  if (b.fixtures.length > 0) {
    lines.push(
      `fixtures count=${b.fixtures.length} reason="fixture files are excluded from fixes by default"`,
    );
  }

  if (b.outOfScope.length > 0) {
    lines.push(
      `out-of-scope count=${b.outOfScope.length} reason="outside the current fix scope or explicitly excluded"`,
    );
  }

  if (b.reportOnly.length > 0) {
    lines.push(
      `report-only count=${b.reportOnly.length} reason="unsupported or report-only findings"`,
    );
  }

  if (verbose) {
    for (const f of report.findings) {
      lines.push(
        `finding retryId=${f.retryId ?? ""} status=${f.status} strategy=${f.repairStrategy ?? ""} tool=${f.tool} location=${JSON.stringify(`${f.file}:${f.range.startLine}`)} rule=${JSON.stringify(f.rule)} reason=${JSON.stringify(f.status === "fixed" ? "" : findingReason(f))}`,
      );
    }
  }

  lines.push(
    'next command="tend diff" command="git add -p" command="tend undo"',
  );
  return lines.join("\n");
}

function repairStrategyCounts(report: Report): Map<string, number> {
  const counts = new Map<string, number>();
  for (const finding of report.findings) {
    if (!finding.repairStrategy) continue;
    counts.set(finding.repairStrategy, (counts.get(finding.repairStrategy) ?? 0) + 1);
  }
  return counts;
}

function renderTable(head: string[], rows: string[][]): string {
  const table = new Table({
    head,
    wordWrap: true,
    style: { head: [], border: [] },
  });
  table.push(...rows);
  return table.toString();
}

function renderOverallTable(report: Report, b: Buckets, theme: Theme): string {
  const couldntFix = couldntFixFindings(b);
  const clean =
    b.fixed.length === 0 &&
    couldntFix.length === 0 &&
    b.skippedTests.length === 0 &&
    b.generated.length === 0 &&
    b.fixtures.length === 0 &&
    b.outOfScope.length === 0 &&
    b.reportOnly.length === 0 &&
    b.unresolvedEligible.length === 0 &&
    b.secrets.length === 0 &&
    !hasFailureSummary(report);
  const status =
    report.exitStatus === 0
      ? clean
        ? theme.fixed("success (nothing to fix)")
        : theme.fixed("success")
      : theme.error(`needs attention (exit ${report.exitStatus})`);
  const rows = [
    ["status", status],
    ["fix passes", String(report.loops)],
    ...(report.finalIntegration && !report.finalIntegration.ok
      ? ([["final integration", theme.error(firstLine(report.finalIntegration.detail ?? "failed"))]] as string[][])
      : []),
    ["elapsed", formatDuration(report.durationMs)],
    ["fixed", `${theme.fixed(theme.glyph.fixed)} ${b.fixed.length}`],
    [
      "timed out/session error",
      `${theme.reverted(theme.glyph.reverted)} ${b.timedOutSessionError.length}`,
    ],
    [
      "regressed",
      `${theme.reverted(theme.glyph.reverted)} ${b.regressed.length}`,
    ],
    [
      "typecheck failed",
      `${theme.reverted(theme.glyph.reverted)} ${b.typecheckFailed.length}`,
    ],
    [
      "test failed",
      `${theme.reverted(theme.glyph.reverted)} ${b.testFailed.length}`,
    ],
    ["retries exhausted", `${theme.reverted(theme.glyph.reverted)} ${b.retryExhausted.length}`],
    [
      "skipped tests",
      `${theme.dim(theme.glyph.left)} ${b.skippedTests.length} (pass --include-tests)`,
    ],
    ["skipped generated", `${theme.dim(theme.glyph.left)} ${b.generated.length}`],
    ["skipped fixtures", `${theme.dim(theme.glyph.left)} ${b.fixtures.length}`],
    ["out of scope", `${theme.dim(theme.glyph.left)} ${b.outOfScope.length}`],
    ["report only", `${theme.dim(theme.glyph.left)} ${b.reportOnly.length}`],
    [
      "unresolved eligible",
      `${theme.dim(theme.glyph.left)} ${b.unresolvedEligible.length}`,
    ],
    [
      "secrets",
      b.secrets.length > 0 ? theme.error(String(b.secrets.length)) : "0",
    ],
    [
      "tool failures",
      report.failureSummary.toolFailures > 0
        ? theme.error(String(report.failureSummary.toolFailures))
        : "0",
    ],
    [
      "failed deterministic fixes",
      report.failureSummary.failedDeterministic > 0
        ? theme.error(String(report.failureSummary.failedDeterministic))
        : "0",
    ],
    ["estimated AI cost", formatCost(report.aiUsage.estimatedCostUsd)],
    ["AI sessions", String(report.aiUsage.sessions)],
    ["tokens", formatTokens(report.aiUsage)],
  ];
  if (report.exitStatus !== 0 && !hasFailureSummary(report) && couldntFix.length === 0) {
    rows.splice(1, 0, [
      "failure reason",
      theme.error("exit status set without recorded blocking findings"),
    ]);
  }
  return renderTable(["metric", "value"], rows);
}

function hasFailureSummary(report: Report): boolean {
  const summary = report.failureSummary;
  return (
    summary.blockingSecrets > 0 ||
    summary.unresolvedEligible > 0 ||
    summary.toolFailures > 0 ||
    summary.failedDeterministic > 0 ||
    summary.sessionErrors > 0 ||
    summary.regressions > 0 ||
    summary.typecheckFailures > 0 ||
    summary.testFailures > 0
    || summary.sandboxSetupFailures > 0
    || summary.patchConflicts > 0
    || summary.unownedPatches > 0
    || summary.finalIntegrationFailures > 0
  );
}

/** Estimated AI cost as `$X.XX` — always two decimals, never called a "bill". */
function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** `<input> in · <output> out · <cache read> cache read · <cache write> cache write`. */
function formatTokens(u: Report["aiUsage"]): string {
  return [
    `${u.inputTokens} in`,
    `${u.outputTokens} out`,
    `${u.cacheReadInputTokens} cache read`,
    `${u.cacheCreationInputTokens} cache write`,
  ].join(" · ");
}

type ScopeCounts = {
  total: number;
  fixed: number;
  couldntFix: number;
  skippedTests: number;
  reportOnly: number;
  left: number;
  generated: number;
  fixtures: number;
  outOfScope: number;
};

/** Per-tool tally over the in-scope findings only. */
function inScopeByTool(report: Report): Map<Tool, ScopeCounts> {
  const counts = new Map<Tool, ScopeCounts>();
  for (const f of report.findings) {
    if (f.inScope === false) continue;
    const row = counts.get(f.tool) ?? {
      total: 0,
      fixed: 0,
      couldntFix: 0,
      skippedTests: 0,
      reportOnly: 0,
      left: 0,
      generated: 0,
      fixtures: 0,
      outOfScope: 0,
    };
    row.total += 1;
    if (f.status === "fixed") row.fixed += 1;
    else if (f.status === "reverted" || f.status === "unfixable")
      row.couldntFix += 1;
    else {
      const pending = classifyPending(f, report);
      if (pending === "skippedTests") row.skippedTests += 1;
      else if (pending === "generated") row.generated += 1;
      else if (pending === "fixtures") row.fixtures += 1;
      else if (pending === "outOfScope") row.outOfScope += 1;
      else if (pending === "reportOnly") row.reportOnly += 1;
      else row.left += 1;
    }
    counts.set(f.tool, row);
  }
  return counts;
}

function renderScannerBreakdownTable(report: Report, theme: Theme): string {
  const counts = inScopeByTool(report);
  const statusByTool = new Map(report.scannerStatuses.map((s) => [s.tool, s]));
  const tools = TOOLS.filter((t) => statusByTool.has(t) || counts.has(t));
  if (tools.length === 0) {
    return renderTable(
      scannerBreakdownHeaders(),
      [
        [
          "(none)",
          "not recorded",
          scopeLabel(report),
          "0",
          "0",
          "0",
          "0",
          "0",
          "0",
          "0",
          "0",
          "0",
          "",
        ],
      ],
    );
  }

  const rows = tools.map((tool) => {
    const status = statusByTool.get(tool);
    const c = counts.get(tool) ?? {
      total: 0,
      fixed: 0,
      couldntFix: 0,
      skippedTests: 0,
      reportOnly: 0,
      left: 0,
      generated: 0,
      fixtures: 0,
      outOfScope: 0,
    };
    const label = scannerLabel(tool);
    const statusText =
      status?.status === "ran"
        ? `${theme.fixed(theme.glyph.fixed)} ran`
        : status?.status === "failed"
          ? `${theme.error("!")} failed`
          : status?.status === "skipped"
            ? "skipped"
            : "not recorded";
    const reason =
      status?.status === "failed" && status.reason
        ? firstLine(status.reason)
        : status?.status === "skipped"
          ? "not installed"
          : "";
    return [
      label,
      statusText,
      scopeLabel(report),
      String(c.total),
      String(c.fixed),
      String(c.couldntFix),
      String(c.skippedTests),
      String(c.reportOnly),
      String(c.left),
      String(c.generated),
      String(c.fixtures),
      String(c.outOfScope),
      reason,
    ];
  });
  return renderTable(scannerBreakdownHeaders(), rows);
}

function scannerBreakdownHeaders(): string[] {
  return [
    "scanner",
    "status",
    "scope",
    "total",
    "fixed",
    "couldn't fix",
    "skipped tests",
    "report only",
    "unresolved eligible",
    "generated",
    "fixtures",
    "out of scope",
    "reason",
  ];
}

function scopeLabel(report: Report): string {
  if (report.runScope.type === "all") return "whole repo";
  if (report.runScope.fileCount !== undefined)
    return `${report.runScope.fileCount} scoped ${report.runScope.fileCount === 1 ? "file" : "files"}`;
  return "in your changes";
}

function plainScopeLabel(report: Report): string {
  return scopeLabel(report).replaceAll(" ", "-");
}

function findingReason(f: Finding): string {
  if (f.finalFailureClass === "tool-timeout") return "timeout/session error";
  if (f.finalFailureClass === "rate-limit") return "rate limited";
  if (f.finalFailureClass === "no-op") return "no-op";
  if (f.finalFailureClass === "sandbox-setup-failed") return "sandbox setup failed";
  if (f.finalFailureClass === "patch-conflict") return "patch conflict";
  if (f.finalFailureClass === "unowned-patch") return "unowned patch";
  if (f.finalFailureClass === "final-integration-failed") return "final integration failed";
  switch (f.revertReason) {
    case "session-error":
      return "timeout/session error";
    case "regression":
      return "regression introduced";
    case "typecheck":
      return "typecheck failed";
    case "broke-test":
      return "tests failed";
    case "suppression":
      return "added a suppression";
    default:
      return "retries exhausted";
  }
}

function retryTarget(f: Finding): string {
  return f.retryId ?? f.id;
}

type CouldntFixReason =
  | "sandbox setup failed"
  | "patch conflict"
  | "unowned patch"
  | "session error"
  | "regression"
  | "typecheck failed"
  | "test failed"
  | "retries exhausted"
  | "unsupported / report-only";

type CouldntFixReasonGroup = {
  reason: CouldntFixReason;
  findings: Finding[];
};

const COULDNT_FIX_REASON_ORDER: CouldntFixReason[] = [
  "sandbox setup failed",
  "patch conflict",
  "unowned patch",
  "session error",
  "regression",
  "typecheck failed",
  "test failed",
  "retries exhausted",
  "unsupported / report-only",
];

function couldntFixReason(f: Finding): CouldntFixReason {
  if (f.track === "report-only") return "unsupported / report-only";
  if (f.finalFailureClass === "sandbox-setup-failed") return "sandbox setup failed";
  if (f.finalFailureClass === "patch-conflict") return "patch conflict";
  if (f.finalFailureClass === "unowned-patch") return "unowned patch";
  if (
    f.revertReason === "session-error" ||
    f.finalFailureClass === "tool-timeout" ||
    f.finalFailureClass === "rate-limit" ||
    f.finalFailureClass === "model-tool-failure" ||
    f.finalFailureClass === "no-edit"
  )
    return "session error";
  if (f.revertReason === "regression" || f.finalFailureClass === "regression")
    return "regression";
  if (f.revertReason === "typecheck" || f.finalFailureClass === "typecheck")
    return "typecheck failed";
  if (f.revertReason === "broke-test" || f.finalFailureClass === "broke-test")
    return "test failed";
  return "retries exhausted";
}

export function groupCouldntFixByReason(
  findings: Finding[],
): CouldntFixReasonGroup[] {
  const groups = new Map<CouldntFixReason, Finding[]>();
  for (const finding of findings) {
    const reason = couldntFixReason(finding);
    const group = groups.get(reason) ?? [];
    group.push(finding);
    groups.set(reason, group);
  }
  return COULDNT_FIX_REASON_ORDER.flatMap((reason) => {
    const group = groups.get(reason);
    return group && group.length > 0 ? [{ reason, findings: group }] : [];
  });
}

export function truncateCell(value: string, maxLength = 64): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function uniqueExampleFiles(findings: Finding[], maxFiles = 3): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const finding of findings) {
    if (seen.has(finding.file)) continue;
    seen.add(finding.file);
    files.push(finding.file);
    if (files.length >= maxFiles) break;
  }
  return files;
}

function nextActionForCouldntFixGroup(findings: Finding[]): string {
  if (findings.length === 1) return `tend retry ${retryTarget(findings[0]!)}`;
  return "run with --verbose";
}

export function renderCouldntFixSummaryTable(findings: Finding[]): string {
  const rows = groupCouldntFixByReason(findings).map((group) => [
    group.reason,
    String(group.findings.length),
    uniqueExampleFiles(group.findings)
      .map((file) => truncateCell(file, 56))
      .join(", "),
    nextActionForCouldntFixGroup(group.findings),
  ]);
  return renderTable(["reason", "count", "examples", "next action"], rows);
}

export function renderCouldntFixDetailTable(
  findings: Finding[],
  theme: Theme,
): string {
  const rows = findings.map((f) => [
    f.retryId ?? "(none)",
    f.file,
    String(f.range.startLine),
    f.rule,
    findingReason(f),
    firstLine(f.revertDetail ?? ""),
    `${theme.glyph.arrow} tend retry ${retryTarget(f)}`,
  ]);
  return renderTable(
    ["retryId", "file", "line", "rule", "reason", "detail", "command"],
    rows,
  );
}

function renderSecretsTable(findings: Finding[], theme: Theme): string {
  const rows = findings.map((f) => [
    f.retryId ?? "(none)",
    f.file,
    f.rule,
    theme.error("rotate + scrub history"),
  ]);
  return renderTable(["retryId", "file", "rule", "action"], rows);
}

function renderNextCommandsTable(): string {
  return renderTable(
    ["action", "command"],
    [
      ["review edits", "tend diff"],
      ["stage deliberately", "git add -p"],
      ["undo run", "tend undo"],
    ],
  );
}

/** First line of a (possibly multi-line) scanner error reason, trimmed. */
function firstLine(s: string): string {
  return s.split("\n")[0]!.trim();
}

function scannerLabel(tool: Tool): string {
  return tool === "sonarjs" ? "sonarjs (bundled)" : tool;
}

type ToolCounts = { fixed: number; reverted: number; left: number };

function perToolCounts(findings: Finding[]): Map<Tool, ToolCounts> {
  const counts = new Map<Tool, ToolCounts>();
  for (const f of findings) {
    const row = counts.get(f.tool) ?? { fixed: 0, reverted: 0, left: 0 };
    if (f.status === "fixed") row.fixed += 1;
    else if (f.status === "reverted") row.reverted += 1;
    else row.left += 1;
    counts.set(f.tool, row);
  }
  return counts;
}

/** The exhaustive view behind `--verbose`: per-tool breakdown + every finding. */
function renderVerbose(report: Report, theme: Theme): string {
  const table = new Table({
    head: ["tool", "fixed", "reverted", "left"],
    style: { head: [], border: [] },
  });
  for (const [tool, c] of perToolCounts(report.findings)) {
    table.push([tool, String(c.fixed), String(c.reverted), String(c.left)]);
  }
  const findingRows = report.findings.map((f) => [
    f.retryId ?? "",
    f.status,
    f.repairStrategy ?? "",
    f.tool,
    `${f.file}:${f.range.startLine}`,
    f.rule,
    f.status === "fixed" ? "" : findingReason(f),
  ]);
  return [
    theme.bold("verbose totals"),
    table.toString(),
    theme.bold("verbose findings"),
    renderTable(
      ["retryId", "status", "strategy", "tool", "location", "rule", "reason"],
      findingRows,
    ),
  ].join("\n");
}

export type RemainingKey = "secrets" | "security" | "couldnt-fix" | "review";
export type RemainingGroup = {
  key: RemainingKey;
  title: string;
  count: number;
};

/**
 * Group the issues that still need a human, ordered by urgency:
 * secrets → security → couldn't-fix → needs-review. Empty groups are omitted.
 */
export function groupRemaining(report: Report): RemainingGroup[] {
  const unfixed = report.findings.filter((f) => f.status !== "fixed");
  const secrets = unfixed.filter((f) => f.category === "secret");
  const security = unfixed.filter((f) => f.category === "security");
  const couldntFix = unfixed.filter(
    (f) =>
      f.status === "unfixable" &&
      f.category !== "secret" &&
      f.category !== "security",
  );

  const groups: RemainingGroup[] = [
    {
      key: "secrets",
      title: "SECRETS — rotate now (never auto-fixed)",
      count: secrets.length,
    },
    { key: "security", title: "SECURITY", count: security.length },
    { key: "couldnt-fix", title: "COULDN'T FIX", count: couldntFix.length },
    {
      key: "review",
      title: "NEEDS YOUR REVIEW — behavior changed",
      count: report.flaggedBehaviorChanges.length,
    },
  ];

  return groups.filter((g) => g.count > 0);
}
