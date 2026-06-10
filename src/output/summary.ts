import Table from "cli-table3";
import { TOOLS, type Finding, type Tool } from "../findings/finding.js";
import { isTestFile } from "../fixing/dispatch.js";
import type { Report } from "../report/schema.js";
import type { AuditExclusions } from "./events.js";
import { formatDuration } from "./format.js";
import { makeTheme, type Theme } from "./theme.js";

const RULE_WIDTH = 49;

const PLAIN_THEME = makeTheme({
  color: false,
  interactive: false,
  unicode: true,
});

type SummaryOptions = {
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

function emptyBuckets(): Buckets {
  return {
    fixed: [],
    skippedTests: [],
    generated: [],
    fixtures: [],
    outOfScope: [],
    reportOnly: [],
    timedOutSessionError: [],
    regressed: [],
    typecheckFailed: [],
    testFailed: [],
    retryExhausted: [],
    unresolvedEligible: [],
    secrets: [],
  };
}

/** Which `reverted`/`unfixable` bucket a finding belongs to, by revert cause. */
function classifyReverted(f: Finding): keyof Buckets {
  if (f.revertReason === "session-error" || f.finalFailureClass === "tool-timeout")
    return "timedOutSessionError";
  if (f.revertReason === "regression") return "regressed";
  if (f.revertReason === "typecheck") return "typecheckFailed";
  if (f.revertReason === "broke-test") return "testFailed";
  return "retryExhausted";
}

/** The bucket a finding belongs to, or `null` when it should be dropped entirely. */
function classifyFinding(f: Finding, report: Report): keyof Buckets | null {
  if (f.category === "secret") return "secrets";
  // Out-of-scope findings are reported on the separate repo-wide line, never folded into
  // the headline counts — so "0 in your changes" can't read as "the repo is clean".
  if (isOutOfScope(f)) return "outOfScope";
  if (f.inReportScope === false) return null;
  if (f.status === "fixed") return "fixed";
  if (f.status === "reverted" || f.status === "unfixable")
    return classifyReverted(f);
  const pending = classifyPending(f, report.fixPolicy.includeTests);
  return pending === "left" ? "unresolvedEligible" : pending;
}

function bucket(report: Report): Buckets {
  const buckets = emptyBuckets();
  for (const f of report.findings) {
    const key = classifyFinding(f, report);
    if (key) buckets[key].push(f);
  }
  return buckets;
}

function classifyPending(f: Finding, includeTests: boolean): PendingBucket {
  if (f.inFixScope === false) {
    if (f.scopeExclusionReason === "generated") return "generated";
    if (f.scopeExclusionReason === "fixtures") return "fixtures";
    if (f.scopeExclusionReason === "tests") return "skippedTests";
    return "outOfScope";
  }
  if (f.track === "report-only") return "reportOnly";
  if (f.track === "ai-fix" && !includeTests && isTestFile(f.file))
    return "skippedTests";
  return "left";
}

/**
 * The audit-time funnel over in-scope findings: how many the fix policy will dispatch
 * ("eligible") and per-reason counts for the rest. Feeds the `audit` event so reporters can
 * explain the in-scope → dispatched collapse the moment it happens.
 */
export function auditEligibility(
  findings: Finding[],
  includeTests: boolean,
): { eligible: number; excluded: AuditExclusions } {
  const excluded: AuditExclusions = {
    tests: 0,
    generated: 0,
    fixtures: 0,
    outOfScope: 0,
    reportOnly: 0,
  };
  let eligible = 0;
  for (const f of findings) {
    const pending = classifyPending(f, includeTests);
    if (pending === "left") eligible++;
    else if (pending === "skippedTests") excluded.tests++;
    else if (pending === "generated") excluded.generated++;
    else if (pending === "fixtures") excluded.fixtures++;
    else if (pending === "outOfScope") excluded.outOfScope++;
    else excluded.reportOnly++;
  }
  return { eligible, excluded };
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
  const headlineMeta = `${glyph.bullet} ${report.loops} fix passes ${glyph.bullet} ${formatDuration(report.durationMs)}`;
  lines.push(`done ${theme.dim(headlineMeta)}`);
  lines.push("");
  lines.push(theme.bold("run summary"));
  lines.push(renderOverallTable(report, b, theme));

  lines.push("");
  lines.push(theme.bold("scanner breakdown"));
  lines.push(renderScannerBreakdownTable(report, theme, opts.verbose));

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
    plainSummaryLine(b),
    plainAiUsageLine(report),
  ];
  lines.push(...plainStrategyLines(report));
  lines.push(...plainFailureLines(report));
  lines.push(...plainScannerLines(report));
  lines.push(...plainCouldntFixLines(b));
  lines.push(...plainSecretLines(b));
  lines.push(...plainExclusionLines(b));
  if (verbose) lines.push(...plainVerboseLines(report));
  lines.push(
    'next command="tend diff" command="git add -p" command="tend undo"',
  );
  return lines.join("\n");
}

/** The single `summary ...` headline line of the plain (machine) output. */
function plainSummaryLine(b: Buckets): string {
  return [
    "summary",
    `fixed=${b.fixed.length}`,
    `couldntFix=${couldntFixFindings(b).length}`,
    `skippedTests=${b.skippedTests.length}`,
    `reportOnly=${b.reportOnly.length}`,
    `secrets=${b.secrets.length}`,
    `generated=${b.generated.length}`,
    `fixtures=${b.fixtures.length}`,
    `outOfScope=${b.outOfScope.length}`,
    `unresolvedEligible=${b.unresolvedEligible.length}`,
    `timedOutSessionError=${b.timedOutSessionError.length}`,
    `regressed=${b.regressed.length}`,
    `typecheckFailed=${b.typecheckFailed.length}`,
    `testFailed=${b.testFailed.length}`,
  ].join(" ");
}

/** The single `aiUsage ...` line of the plain output. */
function plainAiUsageLine(report: Report): string {
  return [
    "aiUsage",
    `estimatedCostUsd=${report.aiUsage.estimatedCostUsd.toFixed(2)}`,
    `sessions=${report.aiUsage.sessions}`,
    `inputTokens=${report.aiUsage.inputTokens}`,
    `outputTokens=${report.aiUsage.outputTokens}`,
    `cacheReadInputTokens=${report.aiUsage.cacheReadInputTokens}`,
    `cacheCreationInputTokens=${report.aiUsage.cacheCreationInputTokens}`,
  ].join(" ");
}

/** The `repairStrategies ...` line, omitted when no strategies were recorded. */
function plainStrategyLines(report: Report): string[] {
  const strategyCounts = repairStrategyCounts(report);
  if (strategyCounts.size === 0) return [];
  return [
    [
      "repairStrategies",
      ...[...strategyCounts.entries()].map(
        ([strategy, count]) => `${strategy}=${count}`,
      ),
    ].join(" "),
  ];
}

/** The `failureSummary ...` line (plus final-integration), omitted on clean success. */
function plainFailureLines(report: Report): string[] {
  if (report.exitStatus === 0 && !hasFailureSummary(report)) return [];
  const lines = [
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
  ];
  if (report.finalIntegration && !report.finalIntegration.ok) {
    lines.push(
      `final-integration status=failed files=${report.finalIntegration.files.length} detail=${JSON.stringify(firstLine(report.finalIntegration.detail ?? ""))}`,
    );
  }
  return lines;
}

/** The trailing ` reason=...` suffix for a plain `scanner ...` line. */
function plainScannerReason(
  status: Report["scannerStatuses"][number] | undefined,
): string {
  if (status?.status === "failed" && status.reason)
    return ` reason=${JSON.stringify(firstLine(status.reason))}`;
  if (status?.status === "skipped") return " reason=not-installed";
  return "";
}

/** One `scanner ...` line per tool that ran or has findings. */
function plainScannerLines(report: Report): string[] {
  const counts = inScopeByTool(report);
  const statusByTool = new Map(report.scannerStatuses.map((s) => [s.tool, s]));
  const tools = TOOLS.filter((t) => statusByTool.has(t) || counts.has(t));
  return tools.map((tool) => {
    const status = statusByTool.get(tool);
    const c = counts.get(tool) ?? emptyScopeCounts();
    const reason = plainScannerReason(status);
    return `scanner tool=${tool} status=${status?.status ?? "not-recorded"} scope=${plainScopeLabel(report)} total=${c.total} fixed=${c.fixed} couldntFix=${c.couldntFix} skippedTests=${c.skippedTests} reportOnly=${c.reportOnly} left=${c.left} generated=${c.generated} fixtures=${c.fixtures} outOfScope=${c.outOfScope}${reason}`;
  });
}

/** One `couldnt-fix ...` line per finding tend gave up on. */
function plainCouldntFixLines(b: Buckets): string[] {
  return couldntFixFindings(b).map((f) => {
    const command = `tend retry ${retryTarget(f)}`;
    return `couldnt-fix retryId=${f.retryId ?? "(none)"} file=${JSON.stringify(f.file)} rule=${JSON.stringify(f.rule)} reason=${JSON.stringify(findingReason(f))} detail=${JSON.stringify(firstLine(f.revertDetail ?? ""))} command=${JSON.stringify(command)}`;
  });
}

/** One `secret ...` line per secret finding. */
function plainSecretLines(b: Buckets): string[] {
  return b.secrets.map(
    (f) =>
      `secret retryId=${f.retryId ?? "(none)"} file=${JSON.stringify(f.file)} rule=${JSON.stringify(f.rule)} action=${JSON.stringify("rotate + scrub history")}`,
  );
}

/** The excluded-bucket lines (skipped tests, generated, fixtures, out-of-scope, report-only). */
function plainExclusionLines(b: Buckets): string[] {
  const lines: string[] = [];
  if (b.skippedTests.length > 0)
    lines.push(
      `skipped-tests count=${b.skippedTests.length} reason="test files are excluded by default" command="tend run --include-tests <path...>"`,
    );
  if (b.generated.length > 0)
    lines.push(
      `generated count=${b.generated.length} reason="generated/cache/build output is excluded from fixes by default"`,
    );
  if (b.fixtures.length > 0)
    lines.push(
      `fixtures count=${b.fixtures.length} reason="fixture files are excluded from fixes by default"`,
    );
  if (b.outOfScope.length > 0)
    lines.push(
      `out-of-scope count=${b.outOfScope.length} reason="outside the current fix scope or explicitly excluded"`,
    );
  if (b.reportOnly.length > 0)
    lines.push(
      `report-only count=${b.reportOnly.length} reason="unsupported or report-only findings"`,
    );
  return lines;
}

/** One `finding ...` line per finding, emitted only under `--verbose`. */
function plainVerboseLines(report: Report): string[] {
  return report.findings.map((f) => {
    const location = `${f.file}:${f.range.startLine}`;
    const reason = f.status === "fixed" ? "" : findingReason(f);
    return `finding retryId=${f.retryId ?? ""} status=${f.status} strategy=${f.repairStrategy ?? ""} tool=${f.tool} location=${JSON.stringify(location)} rule=${JSON.stringify(f.rule)} reason=${JSON.stringify(reason)}`;
  });
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

/** The headline `status` cell: error when exiting non-zero, otherwise success. */
function overallStatusText(
  report: Report,
  clean: boolean,
  theme: Theme,
): string {
  if (report.exitStatus !== 0)
    return theme.error(`needs attention (exit ${report.exitStatus})`);
  return clean
    ? theme.fixed("success (nothing to fix)")
    : theme.fixed("success");
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
  const status = overallStatusText(report, clean, theme);
  // Failure/exclusion rows appear only when non-zero so a typical run isn't a wall of zeros.
  const revertedRow = (label: string, count: number): string[][] =>
    count > 0 ? [[label, `${theme.reverted(theme.glyph.reverted)} ${count}`]] : [];
  const leftRow = (label: string, count: number, suffix = ""): string[][] =>
    count > 0 ? [[label, `${theme.dim(theme.glyph.left)} ${count}${suffix}`]] : [];
  const errorRow = (label: string, count: number): string[][] =>
    count > 0 ? [[label, theme.error(String(count))]] : [];
  const rows = [
    ["status", status],
    ["scope", scopeLabel(report)],
    ["fix passes", String(report.loops)],
    ...(report.finalIntegration && !report.finalIntegration.ok
      ? ([["final integration", theme.error(firstLine(report.finalIntegration.detail ?? "failed"))]] as string[][])
      : []),
    ["elapsed", formatDuration(report.durationMs)],
    ["fixed", `${theme.fixed(theme.glyph.fixed)} ${b.fixed.length}`],
    ...revertedRow("timed out/session error", b.timedOutSessionError.length),
    ...revertedRow("regressed", b.regressed.length),
    ...revertedRow("typecheck failed", b.typecheckFailed.length),
    ...revertedRow("test failed", b.testFailed.length),
    ...revertedRow("retries exhausted", b.retryExhausted.length),
    ...leftRow("skipped tests", b.skippedTests.length, " (pass --include-tests)"),
    ...leftRow("skipped generated", b.generated.length),
    ...leftRow("skipped fixtures", b.fixtures.length),
    ...leftRow("elsewhere in repo (outside fix scope)", b.outOfScope.length),
    ...leftRow("report only", b.reportOnly.length),
    ...leftRow("unresolved eligible", b.unresolvedEligible.length),
    ...errorRow("secrets", b.secrets.length),
    ...errorRow("tool failures", report.failureSummary.toolFailures),
    ...errorRow("failed deterministic fixes", report.failureSummary.failedDeterministic),
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

/** A fresh zeroed `ScopeCounts` tally. */
function emptyScopeCounts(): ScopeCounts {
  return {
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
}

/** The `ScopeCounts` field a finding contributes to (besides `total`). */
function scopeCountKey(f: Finding, report: Report): keyof ScopeCounts {
  if (f.status === "fixed") return "fixed";
  if (f.status === "reverted" || f.status === "unfixable") return "couldntFix";
  return classifyPending(f, report.fixPolicy.includeTests);
}

/** Per-tool tally over the in-scope findings only. */
function inScopeByTool(report: Report): Map<Tool, ScopeCounts> {
  const counts = new Map<Tool, ScopeCounts>();
  for (const f of report.findings) {
    if (f.inScope === false) continue;
    const row = counts.get(f.tool) ?? emptyScopeCounts();
    row.total += 1;
    row[scopeCountKey(f, report)] += 1;
    counts.set(f.tool, row);
  }
  return counts;
}

/** A single cell of the placeholder row shown when no scanners ran. */
function emptyScannerCell(index: number): string {
  if (index === 0) return "(none)";
  if (index === 1) return "not recorded";
  return "0";
}

/** The `status` cell for a scanner-breakdown row. */
function scannerStatusText(
  status: Report["scannerStatuses"][number] | undefined,
  theme: Theme,
): string {
  if (status?.status === "ran") return `${theme.fixed(theme.glyph.fixed)} ran`;
  if (status?.status === "failed") return `${theme.error("!")} failed`;
  if (status?.status === "skipped") return "skipped";
  return "not recorded";
}

/** The `reason` cell for a scanner-breakdown row. */
function scannerReasonText(
  status: Report["scannerStatuses"][number] | undefined,
): string {
  if (status?.status === "failed" && status.reason)
    return firstLine(status.reason);
  if (status?.status === "skipped") return "not installed";
  return "";
}

function renderScannerBreakdownTable(report: Report, theme: Theme, verbose = false): string {
  const counts = inScopeByTool(report);
  const statusByTool = new Map(report.scannerStatuses.map((s) => [s.tool, s]));
  const tools = TOOLS.filter((t) => statusByTool.has(t) || counts.has(t));
  if (tools.length === 0) {
    const headers = scannerBreakdownHeaders(verbose);
    const emptyRow = Array.from({ length: headers.length }, (_, i) =>
      emptyScannerCell(i),
    );
    return renderTable(headers, [emptyRow]);
  }

  const rows = tools.map((tool) => {
    const status = statusByTool.get(tool);
    const c = counts.get(tool) ?? emptyScopeCounts();
    const label = scannerLabel(tool);
    const statusText = scannerStatusText(status, theme);
    const reason = scannerReasonText(status);
    const base = [label, statusText, String(c.total), String(c.fixed), String(c.couldntFix), String(c.left)];
    if (verbose) return [...base, String(c.skippedTests), String(c.reportOnly), String(c.generated), String(c.fixtures), String(c.outOfScope), reason];
    // "excluded" rolls up every policy bucket so total = fixed + couldn't fix + left + excluded.
    const excluded = c.skippedTests + c.reportOnly + c.generated + c.fixtures + c.outOfScope;
    return [...base, String(excluded), reason];
  });
  return renderTable(scannerBreakdownHeaders(verbose), rows);
}

function scannerBreakdownHeaders(verbose: boolean): string[] {
  const base = ["scanner", "status", "total", "fixed", "couldn't fix", "left"];
  if (verbose) return [...base, "skipped tests", "report only", "generated", "fixtures", "out of scope", "reason"];
  return [...base, "excluded", "reason"];
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

function groupCouldntFixByReason(
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

function truncateCell(value: string, maxLength = 64): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function uniqueExampleFiles(findings: Finding[], maxFiles = 3): string[] {
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

function renderCouldntFixSummaryTable(findings: Finding[]): string {
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

function renderCouldntFixDetailTable(
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

type RemainingKey = "secrets" | "security" | "couldnt-fix" | "review";
type RemainingGroup = {
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
