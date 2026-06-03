import type { RawFinding } from "../findings/normalize.js";
import type { Finding } from "../findings/finding.js";
import { toRepoRelative } from "./paths.js";
import type { Scanner, ScanContext, SpawnResult } from "./scanner.js";

type Pos = { line: number; col: number };
type SemgrepLoc = { path: string; start: Pos; end: Pos };
type LocAndContent = [SemgrepLoc, string];
// Tagged tuple: ["CliLoc", LocAndContent] | ["CliCall", [LocAndContent, IntermediateVar[], CallTrace]]
type CallTrace = ["CliLoc", LocAndContent] | ["CliCall", [LocAndContent, unknown[], CallTrace]];
type IntermediateVar = { location: SemgrepLoc; content: string };
type DataflowTrace = {
  taint_source?: CallTrace;
  intermediate_vars?: IntermediateVar[];
  taint_sink?: CallTrace;
};
type SemgrepResult = {
  check_id: string;
  path: string;
  start: Pos;
  end: Pos;
  extra: {
    message: string;
    severity: string;
    metadata?: { references?: string[] };
    dataflow_trace?: DataflowTrace;
  };
};
type SemgrepReport = { results: SemgrepResult[] };

const SEVERITY: Record<string, Finding["severity"]> = {
  ERROR: "error",
  WARNING: "warning",
  INFO: "info",
};

/** Pull the anchored location out of a taint_source/taint_sink tagged tuple. */
function locOf(trace: CallTrace | undefined): SemgrepLoc | undefined {
  if (!Array.isArray(trace)) return undefined;
  const [tag, payload] = trace;
  if (tag === "CliLoc") return payload[0];
  if (tag === "CliCall") return payload[0][0];
  return undefined;
}

export const semgrepScanner: Scanner = {
  tool: "semgrep",
  binary: "semgrep",

  buildArgs(ctx: ScanContext): string[] {
    return ["--json", "--quiet", ...ctx.files];
  },

  parse(raw: SpawnResult, ctx: ScanContext): RawFinding[] {
    const report = JSON.parse(raw.stdout) as SemgrepReport;
    const rel = (p: string) => toRepoRelative(ctx.cwd, p);

    return (report.results ?? []).map((r) => {
      const finding: RawFinding = {
        tool: "semgrep",
        rule: r.check_id,
        category: "security",
        severity: SEVERITY[r.extra.severity] ?? "warning",
        file: rel(r.path),
        range: { startLine: r.start.line, startCol: r.start.col, endLine: r.end.line, endCol: r.end.col },
        message: r.extra.message,
      };

      const ref = r.extra.metadata?.references?.[0];
      if (ref) finding.helpUri = ref;

      const trace = r.extra.dataflow_trace;
      if (trace) {
        const steps: { file: string; line: number }[] = [];
        const source = locOf(trace.taint_source);
        if (source) steps.push({ file: rel(source.path), line: source.start.line });
        for (const v of trace.intermediate_vars ?? []) {
          steps.push({ file: rel(v.location.path), line: v.location.start.line });
        }
        const sink = locOf(trace.taint_sink);
        if (sink) steps.push({ file: rel(sink.path), line: sink.start.line });
        if (steps.length > 0) finding.flowPath = steps;
      }

      return finding;
    });
  },
};
