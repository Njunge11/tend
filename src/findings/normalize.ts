import { fingerprint, type Finding, type Tool, type Track } from "./finding.js";

/** A scanner-produced record, before tend assigns identity, track, and loop state. */
export type RawFinding = {
  tool: Tool;
  rule: string;
  category: Finding["category"];
  severity: Finding["severity"];
  file: string;
  range: Finding["range"];
  message: string;
  helpUri?: string;
  flowPath?: Finding["flowPath"];
  remediation?: string;
};

const TRACK_BY_TOOL: Record<Tool, Track> = {
  sonarjs: "ai-fix",
  knip: "ai-fix",
  jscpd: "ai-fix",
  semgrep: "ai-fix",
  osv: "deterministic",
  gitleaks: "report-only",
};

/** Which track a tool's findings flow into. */
export function trackForTool(tool: Tool): Track {
  return TRACK_BY_TOOL[tool];
}

/** Turn a raw scanner record into a tracked `Finding` for the given loop. */
export function normalize(raw: RawFinding, loop: number): Finding {
  const id = fingerprint({
    tool: raw.tool,
    rule: raw.rule,
    file: raw.file,
    line: raw.range.startLine,
    message: raw.message,
  });

  const finding: Finding = {
    id,
    tool: raw.tool,
    rule: raw.rule,
    category: raw.category,
    severity: raw.severity,
    file: raw.file,
    range: raw.range,
    message: raw.message,
    track: trackForTool(raw.tool),
    status: "pending",
    attempts: 0,
    firstSeenLoop: loop,
    lastSeenLoop: loop,
  };

  if (raw.helpUri !== undefined) finding.helpUri = raw.helpUri;
  if (raw.flowPath !== undefined) finding.flowPath = raw.flowPath;
  if (raw.remediation !== undefined) finding.remediation = raw.remediation;

  return finding;
}
