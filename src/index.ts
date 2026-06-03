// Public API surface for `tend-cli` (programmatic use).

export { fingerprint, FindingSchema, type Finding, type Tool, type Track } from "./findings/finding.js";
export { normalize, trackForTool, type RawFinding } from "./findings/normalize.js";
export { FindingStore } from "./findings/store.js";
export { route, type RouteResult } from "./findings/router.js";

export {
  runScanner,
  isAvailable,
  type Scanner,
  type ScanContext,
  type ScanResult,
  type Spawn,
  type Which,
} from "./scanners/scanner.js";
export { changedFiles, filterToChanged, scopeFindings } from "./scanners/scope.js";

export { runGate, type Check, type GateOutcome } from "./gate/gate.js";

export { ChangeSet, type FileEdit } from "./fixing/change-set.js";
export { planWork, dispatch, type WorkUnit } from "./fixing/dispatch.js";
export { ClaudeSession } from "./session/claude.js";
export type { SessionRunner, SessionRequest, SessionResult } from "./session/types.js";

export { Snapshot } from "./git/snapshot.js";
export { assertGitRepo, changedVsHead, revertFile } from "./git/repo.js";

export { loadConfig, applyCliOverrides, ConfigSchema, type TendConfig } from "./config/config.js";
export { ReportBuilder } from "./report/builder.js";
export { ReportSchema, type Report } from "./report/schema.js";
export { EventBus, type TendEvent } from "./output/events.js";
export { renderSummary, groupRemaining } from "./output/summary.js";

export {
  orchestrate,
  type OrchestrateDeps,
  type OrchestrateResult,
  type Termination,
  type AuditResult,
  type FixOutcome,
} from "./orchestrator.js";

export { buildProgram, type CliHandlers } from "./cli.js";
export { runCommand } from "./commands/run.js";
export { diffCommand } from "./commands/diff.js";
export { undoCommand } from "./commands/undo.js";
export { showCommand } from "./commands/show.js";
export { retryCommand } from "./commands/retry.js";
