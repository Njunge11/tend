import Table from "cli-table3";
import { TOOLS, type Finding, type Tool } from "../findings/finding.js";
import { isTestFile } from "../fixing/dispatch.js";
import type { Report } from "../report/schema.js";
import { formatDuration, reasonLabel } from "./format.js";
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
  couldntFix: Finding[]; // reverted or unfixable (not a secret)
  skippedTests: Finding[]; // excluded by default unless --include-tests is passed
  left: Finding[]; // unresolved for reasons other than the default test-file exclusion
  secrets: Finding[];
};

/** A finding the developer can't read as part of their changes (scanned wide, out of scope). */
function isOutOfScope(f: Finding): boolean {
  return f.inScope === false && f.category !== "secret";
}

function bucket(findings: Finding[]): Buckets {
  const fixed: Finding[] = [];
  const couldntFix: Finding[] = [];
  const skippedTests: Finding[] = [];
  const left: Finding[] = [];
  const secrets: Finding[] = [];
  for (const f of findings) {
    if (f.category === "secret") secrets.push(f);
    // Out-of-scope findings are reported on the separate repo-wide line, never folded into
    // the headline counts — so "0 in your changes" can't read as "the repo is clean".
    else if (isOutOfScope(f)) continue;
    else if (f.status === "fixed") fixed.push(f);
    else if (f.status === "reverted" || f.status === "unfixable")
      couldntFix.push(f);
    else if (isTestFile(f.file)) skippedTests.push(f);
    else left.push(f);
  }
  return { fixed, couldntFix, skippedTests, left, secrets };
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
  const b = bucket(report.findings);
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

  if (b.couldntFix.length > 0) {
    lines.push("");
    lines.push(theme.bold("couldn't fix"));
    lines.push(renderCouldntFixTable(b.couldntFix, theme));
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
      `couldntFix=${b.couldntFix.length}`,
      `skippedTests=${b.skippedTests.length}`,
      `left=${b.left.length}`,
      `secrets=${b.secrets.length}`,
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

  const counts = inScopeByTool(report.findings);
  const statusByTool = new Map(report.scannerStatuses.map((s) => [s.tool, s]));
  const tools = TOOLS.filter((t) => statusByTool.has(t) || counts.has(t));
  for (const tool of tools) {
    const status = statusByTool.get(tool);
    const c = counts.get(tool) ?? {
      total: 0,
      fixed: 0,
      couldntFix: 0,
      left: 0,
    };
    const reason =
      status?.status === "failed" && status.reason
        ? ` reason=${JSON.stringify(firstLine(status.reason))}`
        : status?.status === "skipped"
          ? " reason=not-installed"
          : "";
    lines.push(
      `scanner tool=${tool} status=${status?.status ?? "not-recorded"} scope=in-your-changes total=${c.total} fixed=${c.fixed} couldntFix=${c.couldntFix} left=${c.left}${reason}`,
    );
  }

  for (const f of b.couldntFix) {
    const id = retryTarget(f);
    lines.push(
      `couldnt-fix retryId=${f.retryId ?? "(none)"} file=${JSON.stringify(f.file)} rule=${JSON.stringify(f.rule)} reason=${JSON.stringify(findingReason(f))} command=${JSON.stringify(`tend retry ${id}`)}`,
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

  if (verbose) {
    for (const f of report.findings) {
      lines.push(
        `finding retryId=${f.retryId ?? ""} status=${f.status} tool=${f.tool} location=${JSON.stringify(`${f.file}:${f.range.startLine}`)} rule=${JSON.stringify(f.rule)} reason=${JSON.stringify(f.status === "fixed" ? "" : findingReason(f))}`,
      );
    }
  }

  lines.push(
    'next command="tend diff" command="git add -p" command="tend undo"',
  );
  return lines.join("\n");
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
  const clean =
    b.fixed.length === 0 &&
    b.couldntFix.length === 0 &&
    b.skippedTests.length === 0 &&
    b.left.length === 0 &&
    b.secrets.length === 0;
  const rows = [
    ["status", clean ? theme.fixed("nothing to fix") : "completed"],
    ["fix passes", String(report.loops)],
    ["elapsed", formatDuration(report.durationMs)],
    ["fixed", `${theme.fixed(theme.glyph.fixed)} ${b.fixed.length}`],
    [
      "couldn't fix",
      `${theme.reverted(theme.glyph.reverted)} ${b.couldntFix.length}`,
    ],
    [
      "skipped tests",
      `${theme.dim(theme.glyph.left)} ${b.skippedTests.length} (pass --include-tests)`,
    ],
    ["left", `${theme.dim(theme.glyph.left)} ${b.left.length}`],
    [
      "secrets",
      b.secrets.length > 0 ? theme.error(String(b.secrets.length)) : "0",
    ],
    ["estimated AI cost", formatCost(report.aiUsage.estimatedCostUsd)],
    ["AI sessions", String(report.aiUsage.sessions)],
    ["tokens", formatTokens(report.aiUsage)],
  ];
  return renderTable(["metric", "value"], rows);
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
  left: number;
};

/** Per-tool tally over the in-scope (your-changes) findings only. */
function inScopeByTool(findings: Finding[]): Map<Tool, ScopeCounts> {
  const counts = new Map<Tool, ScopeCounts>();
  for (const f of findings) {
    if (f.inScope === false) continue;
    const row = counts.get(f.tool) ?? {
      total: 0,
      fixed: 0,
      couldntFix: 0,
      skippedTests: 0,
      left: 0,
    };
    row.total += 1;
    if (f.status === "fixed") row.fixed += 1;
    else if (f.status === "reverted" || f.status === "unfixable")
      row.couldntFix += 1;
    else if (isTestFile(f.file)) row.skippedTests += 1;
    else row.left += 1;
    counts.set(f.tool, row);
  }
  return counts;
}

function renderScannerBreakdownTable(report: Report, theme: Theme): string {
  const counts = inScopeByTool(report.findings);
  const statusByTool = new Map(report.scannerStatuses.map((s) => [s.tool, s]));
  const tools = TOOLS.filter((t) => statusByTool.has(t) || counts.has(t));
  if (tools.length === 0) {
    return renderTable(
      [
        "scanner",
        "status",
        "scope",
        "total",
        "fixed",
        "couldn't fix",
        "skipped tests",
        "left",
        "reason",
      ],
      [["(none)", "not recorded", "in your changes", "0", "0", "0", "0", "0", ""]],
    );
  }

  const rows = tools.map((tool) => {
    const status = statusByTool.get(tool);
    const c = counts.get(tool) ?? {
      total: 0,
      fixed: 0,
      couldntFix: 0,
      skippedTests: 0,
      left: 0,
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
      "in your changes",
      String(c.total),
      String(c.fixed),
      String(c.couldntFix),
      String(c.skippedTests),
      String(c.left),
      reason,
    ];
  });
  return renderTable(
    [
      "scanner",
      "status",
      "scope",
      "total",
      "fixed",
      "couldn't fix",
      "skipped tests",
      "left",
      "reason",
    ],
    rows,
  );
}

function findingReason(f: Finding): string {
  return f.status === "reverted"
    ? reasonLabel(f.revertReason)
    : "exhausted retries";
}

function retryTarget(f: Finding): string {
  return f.retryId ?? f.id;
}

function renderCouldntFixTable(findings: Finding[], theme: Theme): string {
  const rows = findings.map((f) => [
    f.retryId ?? "(none)",
    f.file,
    String(f.range.startLine),
    f.rule,
    f.message,
    findingReason(f),
    `${theme.glyph.arrow} tend retry ${retryTarget(f)}`,
  ]);
  return renderTable(
    ["retryId", "file", "line", "rule", "message", "reason", "command"],
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
      ["retryId", "status", "tool", "location", "rule", "reason"],
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
