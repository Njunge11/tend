import { hasBlockingFailure } from "./_shared.js";
import { FindingStore } from "./findings/store.js";
import { route } from "./findings/router.js";
import type { Finding, Tool } from "./findings/finding.js";
import type { ScannerStatus } from "./scanners/scanner.js";
import type { RevertReason } from "./gate/check.js";
import { chunkUnit, dispatch, planWorkFromRepairs, type WorkUnit } from "./fixing/dispatch.js";
import {
  applyRepairPlanToFinding,
  isAiDispatchStrategy,
  planRepair,
  type RepairPlan,
  type RepairStrategy,
} from "./fixing/repair-strategy.js";
import { EventBus } from "./output/events.js";
import { auditEligibility } from "./output/summary.js";
import { modelForUnit } from "./fixing/model-selection.js";
import { addUsage, zeroUsage, type AiUsage, type FailureClass } from "./session/types.js";
import type { RunScope, Termination } from "./report/schema.js";
import { deriveReportFields } from "./report/builder.js";
import { markScope, type FixScopeConfig } from "./scanners/scope-policy.js";

export type AuditResult = {
  findings: Finding[];
  allScannersMissing?: boolean;
  scanned?: number;
  scannerStatuses?: ScannerStatus[];
};
export type FixOutcome = {
  kept: boolean;
  reason?: RevertReason;
  detail?: string;
  failureClass?: FailureClass;
  usage?: AiUsage;
  /**
   * The dispatch already ran an in-dispatch repair session (regression repair or test repair)
   * for a gate stage and still failed. Re-dispatching from scratch repeats that same fan-out, so
   * the orchestrator stops re-dispatching this finding rather than spending another full pass.
   */
  repairAttempted?: boolean;
};

export type OrchestrateDeps = {
  cwd?: string;
  /** Run the scanners for a loop and return normalized findings. `tools` limits re-audit to only the listed scanners. */
  audit: (loop: number, tools?: Tool[]) => Promise<AuditResult>;
  /** Fix one work unit (session + gate); returns whether the fix was kept. */
  fixUnit: (unit: WorkUnit, loop: number) => Promise<FixOutcome>;
  /** Fix one deterministic work unit without AI usage. */
  deterministicFixUnit?: (unit: WorkUnit, loop: number) => Promise<FixOutcome>;
  config: {
    maxLoops: number;
    perIssueBudget: number;
    maxSessions: number;
    includeTests?: boolean;
    fix?: FixScopeConfig;
    /** Fix model and its capable-model overrides — used to label each job with the model it ran on. */
    model: string;
    duplicationModel?: string;
    complexityModel?: string;
    /** Repo-relative uncommitted files + their import cluster (work in progress) — not auto-deleted as unused. */
    likelyWipFiles?: readonly string[];
  };
  /** Restrict findings to the fix scope (changed files); defaults to all. */
  inScope?: (findings: Finding[]) => Finding[];
  /** Run cancellation (Ctrl-C): pending units are skipped, no new loop starts. */
  signal?: AbortSignal;
  bus?: EventBus;
};

// The loop's stop reason is defined in the report schema (so report.json persists it);
// re-exported here for existing importers.
export type { Termination } from "./report/schema.js";

export type OrchestrateResult = {
  termination: Termination;
  loops: number;
  exitStatus: number;
  findings: Finding[];
  secrets: Finding[];
  reportOnly: Finding[];
  deterministic: Finding[];
  depBumps: Finding[];
  scannerStatuses: ScannerStatus[];
  runScope: RunScope;
  /** Estimated AI cost/usage summed across every fix attempt (including reverted ones). */
  usage: AiUsage;
};

/** AI-fixable findings still pending and under their retry budget. */
function pendingUnderBudget(store: FindingStore, budget: number): Finding[] {
  return store.query({ track: "ai-fix", status: "pending" }).filter((f) => f.attempts < budget);
}

function repairConfig(config: OrchestrateDeps["config"]) {
  return {
    ...config.fix,
    includeTests: config.includeTests,
    likelyWipFiles: config.likelyWipFiles,
  };
}

function plannedRepairs(findings: Finding[], config: OrchestrateDeps["config"], cwd?: string): RepairPlan[] {
  return findings.map((finding) =>
    planRepair({
      finding,
      cwd,
      scope: finding,
      config: repairConfig(config),
      flowPath: finding.flowPath,
      file: finding.file,
      category: finding.category,
      rule: finding.rule,
      tool: finding.tool,
    }),
  );
}

function repairFiles(finding: Finding): string[] {
  return [...new Set([finding.file, ...(finding.flowPath ?? []).map((step) => step.file)])];
}

function needsAllRepairFilesInScope(finding: Finding): boolean {
  return (
    finding.tool === "jscpd" &&
    finding.rule === "duplicate-code" &&
    repairFiles(finding).length > 1
  );
}

function allRepairFilesInScope(
  finding: Finding,
  inScope: (findings: Finding[]) => Finding[],
): boolean {
  return repairFiles(finding).every(
    (file) => inScope([{ ...finding, file, flowPath: undefined }]).length > 0,
  );
}

export function dispatchableUnits(plans: RepairPlan[]): WorkUnit[] {
  // Filter PLANS before unit-building (mirroring `deterministicUnits`). Removing
  // non-dispatchable/`unsupported` (report-only) plans here means they can never reserve a
  // sibling file in `ownerFiles` nor get merged into a dispatchable unit by `mergeUnits` — so a
  // dispatched worker can't edit an out-of-fix-scope file or count its report-only findings as
  // fixed. Filtering the resulting units instead runs too late: the merge has already happened.
  return planWorkFromRepairs(plans.filter((plan) => isAiDispatchStrategy(plan.strategy)));
}

function isDeterministicStrategy(strategy: RepairStrategy | undefined): boolean {
  return strategy?.startsWith("deterministic-") === true;
}

function deterministicUnits(plans: RepairPlan[]): WorkUnit[] {
  return planWorkFromRepairs(plans.filter((plan) => isDeterministicStrategy(plan.strategy)));
}

function statusAttemptSnapshot(store: FindingStore): string {
  return store
    .all()
    .map((f) => `${f.id}:${f.status}:${f.attempts}`)
    .sort((a, b) => a.localeCompare(b))
    .join("|");
}

function classFromOutcome(outcome: FixOutcome): FailureClass | undefined {
  if (outcome.failureClass) return outcome.failureClass;
  switch (outcome.reason) {
    case "regression":
      return "regression";
    case "unresolved-target":
      return "unresolved-target";
    case "typecheck":
      return "typecheck";
    case "broke-test":
      return "broke-test";
    case "suppression":
      return "suppression";
    case "needs-lockfile-update":
      return "needs-lockfile-update";
    case "sandbox-setup-failed":
      return "sandbox-setup-failed";
    case "patch-conflict":
      return "patch-conflict";
    case "unowned-patch":
      return "unowned-patch";
    case "final-integration-failed":
      return "final-integration-failed";
    case "session-error":
      return "model-tool-failure";
    default:
      return undefined;
  }
}

function isTerminalNoBurnFailure(outcome: FixOutcome): boolean {
  // "no-op": the session made no edit and a retry won't help. "model-rejected": the model
  // refused the request in a way retrying can't fix (prompt too long, max-tokens, missing
  // model). "deterministic-unsupported": a deterministic fixer can't handle this code shape, so
  // re-running feeds it the byte-identical input for the same failure. All terminal — mark
  // unfixable without spending the rest of the retry budget.
  return (
    outcome.failureClass === "no-op" ||
    outcome.failureClass === "model-rejected" ||
    outcome.failureClass === "deterministic-unsupported"
  );
}

/**
 * Some failures deserve a bounded retry window smaller than the normal per-issue budget.
 * Gate failures (regression/typecheck/broke-test) already ran an in-dispatch repair session
 * before reverting, so re-dispatching from scratch repeatedly is rarely useful. Tool timeouts
 * are different: they may succeed in a later loop after earlier fixes simplify the file, but
 * they still need a hard cap so one oversized refactor cannot loop forever.
 */
const LIMITED_RETRY_FAILURE_CLASSES: ReadonlySet<FailureClass> = new Set([
  "tool-timeout",
  "regression",
  "unresolved-target",
  "typecheck",
  "broke-test",
]);
const LIMITED_RETRY_BUDGET = 2;

function effectiveBudget(failureClass: FailureClass | undefined, budget: number): number {
  return failureClass && LIMITED_RETRY_FAILURE_CLASSES.has(failureClass)
    ? Math.min(LIMITED_RETRY_BUDGET, budget)
    : budget;
}

/**
 * The orchestrator's verdict for one finding's outcome — the "why" behind whether it will be
 * retried. Emitted as a `debug` decision event so a real run's retry/terminal choices are auditable.
 */
type FindingVerdict =
  | "fixed"
  | "fixed-out-of-scope-skipped"
  | "retry"
  | "budget-exhausted"
  | "terminal-timeout"
  | "terminal-repair-attempted"
  | "terminal-no-burn"
  | "rate-limit-no-burn";

/**
 * A timed-out unit that has nothing left to reduce. A multi-finding batch that times out is
 * worth a bounded retry — splitting it (see {@link shouldSplitAfterFailure}) or a later loop
 * fixing a sibling finding in the same file can let it finish. A SINGLE-finding unit has neither
 * lever: there is no smaller form to split into, and (units own disjoint files) nothing else
 * edits its file, so re-dispatching re-patches byte-identical input for another full timeout —
 * pure waste. Such timeouts are terminal: revert (already done by the gate) and mark unfixable.
 */
function isSingleFindingTimeout(unit: WorkUnit, outcome: FixOutcome): boolean {
  return outcome.failureClass === "tool-timeout" && unit.findings.length === 1;
}

/** Record one reverted/failed outcome against a finding (budget-aware). Returns the verdict + cap. */
function applyFailedOutcome(
  store: FindingStore,
  finding: Finding,
  outcome: FixOutcome,
  budget: number,
  terminalTimeout = false,
): { verdict: FindingVerdict; cap?: number } {
  const reason = outcome.reason ?? "session-error";
  const failureClass = classFromOutcome(outcome);
  if (failureClass === "rate-limit") {
    store.recordFailureWithoutAttempt(finding.id, reason, outcome.detail, failureClass);
    return { verdict: "rate-limit-no-burn" };
  }
  if (isTerminalNoBurnFailure(outcome)) {
    store.recordFailureWithoutAttempt(finding.id, reason, outcome.detail, failureClass!);
    finding.status = "unfixable";
    return { verdict: "terminal-no-burn" };
  }
  if (terminalTimeout) {
    // Burn the attempt (a real session ran and timed out) but do not allow a retry: the next
    // attempt would feed the model the exact same input and time out again.
    store.recordFailedAttempt(finding.id, reason, outcome.detail, failureClass);
    finding.status = "unfixable";
    return { verdict: "terminal-timeout" };
  }
  store.recordFailedAttempt(finding.id, reason, outcome.detail, failureClass);
  // A dispatch that already ran an in-dispatch repair for this gate stage and still failed gets
  // no cross-loop re-dispatch — that would re-run the same initial+repair fan-out (item 5). Other
  // failures keep their normal (limited) budget.
  const cap = outcome.repairAttempted ? 1 : effectiveBudget(failureClass, budget);
  if (store.isBudgetExhausted(finding.id, cap)) {
    finding.status = "unfixable";
    return { verdict: outcome.repairAttempted ? "terminal-repair-attempted" : "budget-exhausted", cap };
  }
  return { verdict: "retry", cap };
}

/** A single finding's resolved verdict, for the `finding.outcome` decision trace. */
type FindingDecision = {
  id: string;
  file: string;
  rule: string;
  tool: string;
  kept: boolean;
  verdict: FindingVerdict;
  reason?: string;
  failureClass?: FailureClass;
  attempts: number;
  status: Finding["status"];
  cap?: number;
};

export function applyOutcome(
  store: FindingStore,
  unit: WorkUnit,
  outcome: FixOutcome,
  budget: number,
  onDecision?: (decision: FindingDecision) => void,
): void {
  const terminalTimeout = isSingleFindingTimeout(unit, outcome);
  for (const finding of unit.findings) {
    let verdict: FindingVerdict;
    let cap: number | undefined;
    if (outcome.kept) {
      // Defense in depth: a kept unit only ever targeted its in-scope findings. Never credit an
      // out-of-fix-scope (report-only) finding as fixed even if one reaches a kept unit by some
      // other path — leave its status untouched (stays pending) so the report can't show it fixed.
      if (finding.inFixScope === false) {
        verdict = "fixed-out-of-scope-skipped";
      } else {
        finding.status = "fixed";
        delete finding.revertReason;
        delete finding.revertDetail;
        delete finding.finalFailureClass;
        verdict = "fixed";
      }
    } else {
      ({ verdict, cap } = applyFailedOutcome(store, finding, outcome, budget, terminalTimeout));
    }
    onDecision?.({
      id: finding.id,
      file: finding.file,
      rule: finding.rule,
      tool: finding.tool,
      kept: outcome.kept,
      verdict,
      reason: outcome.reason,
      failureClass: classFromOutcome(outcome),
      attempts: finding.attempts,
      status: finding.status,
      cap,
    });
  }
}

/**
 * Max findings handed to one AI fix session. A single finding takes ~15–49s, so a batch of 5
 * completes in ~75–245s — comfortably under the 10-min session cap — while still letting one
 * session clear several related findings at once. A file with more findings is processed in
 * sequential batches of this size (see `chunkUnit`), so the doomed full-file batch that always
 * timed out never happens (root causes A+B).
 */
const FIX_BATCH_SIZE = 5;

function splitUnit(unit: WorkUnit): WorkUnit[] {
  if (unit.findings.length <= 1) return [];
  return unit.findings.map((finding) => ({
    ...unit,
    findings: [finding],
    files: [...unit.files],
    verificationTargets: unit.verificationTargets ? [...unit.verificationTargets] : undefined,
    strategies: unit.strategies ? [...unit.strategies] : undefined,
  }));
}

/**
 * Failure classes where a multi-finding batch is worth re-running as single-finding splits: the
 * batch verdict is collective (one finding poisoned a gate that reverts the WHOLE unit), so the
 * good siblings deserve their own isolated attempt instead of being reverted with the culprit.
 * Besides tool-timeout (the batch may simply be too large) and regression (one finding introduced
 * a new issue), this covers typecheck and broke-test — a single finding's edit that breaks the
 * build or a test fails the shared gate and was reverting ~4 good siblings every loop.
 */
const SPLITTABLE_FAILURE_CLASSES: ReadonlySet<FailureClass> = new Set([
  "tool-timeout",
  "regression",
  "typecheck",
  "broke-test",
]);

function shouldSplitAfterFailure(unit: WorkUnit, outcome: FixOutcome): boolean {
  return (
    unit.findings.length > 1 &&
    outcome.failureClass !== undefined &&
    SPLITTABLE_FAILURE_CLASSES.has(outcome.failureClass)
  );
}

/**
 * Loop 2+ re-audits only the tools that previously produced findings, so its status list
 * covers a subset of the scanners. Merge by tool — overwrite the tools that re-ran, keep
 * the previous status for the rest — so the final report never drops a scanner that ran
 * cleanly in loop 1. Previous order is preserved; genuinely new tools are appended.
 */
function mergeScannerStatuses(prev: ScannerStatus[], next: ScannerStatus[]): ScannerStatus[] {
  const byTool = new Map(next.map((status) => [status.tool, status]));
  const prevTools = new Set(prev.map((status) => status.tool));
  return [
    ...prev.map((status) => byTool.get(status.tool) ?? status),
    ...next.filter((status) => !prevTools.has(status.tool)),
  ];
}

/** Mutable per-run state threaded through the loop's helper functions. */
type RunCtx = {
  deps: OrchestrateDeps;
  config: OrchestrateDeps["config"];
  inScope: (findings: Finding[]) => Finding[];
  bus: EventBus;
  store: FindingStore;
  secrets: Map<string, Finding>;
  reportOnly: Map<string, Finding>;
  deterministic: Map<string, Finding>;
  scannerStatuses: ScannerStatus[];
  runScope: RunScope;
  /** Estimated AI cost/usage accumulates across every fix outcome, including reverted ones. */
  usage: AiUsage;
  loop: number;
  fixingLoops: number;
};

type DispatchOutcome = { unit: WorkUnit; outcome: FixOutcome; apply: boolean };

/**
 * Emit one dev-only decision/diagnostic record (the orchestrator's "why"). It rides the event
 * bus as a `debug` event: the live reporters ignore it, while the tracer records it to
 * events.jsonl + decisions.jsonl so a real run's verdicts are auditable after the fact.
 */
function debug(ctx: RunCtx, action: string, detail?: string, data?: Record<string, unknown>): void {
  ctx.bus.emit({ type: "debug", loop: ctx.loop, action, detail, data });
}

/** Emit a `finding.outcome` decision for one finding's resolved verdict. */
function logFindingDecision(ctx: RunCtx, decision: FindingDecision): void {
  debug(
    ctx,
    "finding.outcome",
    `${decision.file} ${decision.tool}/${decision.rule} → ${decision.verdict}` +
      (decision.reason ? ` (${decision.reason})` : ""),
    { ...decision },
  );
}

/** One loop iteration's verdict: stop the run with a reason, or run another iteration. */
type StepResult = { kind: "stop"; termination: Termination } | { kind: "continue" };

/**
 * Tools to re-run this loop. Loop 1 runs everything (undefined). Loop 2+ re-runs only the tools
 * that still carry an in-fix-scope finding: a tool whose findings are ALL out of fix scope (the
 * classic case is knip's repo-wide dead-code report on a subdir run) can't change as a result of
 * tend's fixes — tend never edits the files it flags — so re-running its whole-repo scan every loop
 * is pure wasted time. `reconcile` is told the same set so those un-rescanned findings keep their
 * last known state instead of being misread as resolved (absent → "fixed").
 */
function auditToolsForLoop(ctx: RunCtx): Tool[] | undefined {
  if (ctx.loop <= 1) return undefined;
  return [...new Set(ctx.store.all().filter((f) => f.inFixScope !== false).map((f) => f.tool))] as Tool[];
}

/** Re-audit (subset of scanners after loop 1) and record scanner statuses / run scope. */
async function runAudit(ctx: RunCtx, relevantTools: Tool[] | undefined): Promise<AuditResult> {
  const audited = await ctx.deps.audit(ctx.loop, relevantTools);
  if (audited.scannerStatuses)
    ctx.scannerStatuses = mergeScannerStatuses(ctx.scannerStatuses, audited.scannerStatuses);
  if (ctx.loop === 1) {
    ctx.runScope =
      audited.scanned == null ? { type: "all" } : { type: "scoped", fileCount: audited.scanned };
  }
  return audited;
}

/**
 * Tag each tracked finding by fix scope so the summary can split "your changes" from
 * "repo-wide". `inScope` is identity under `--all` (everything in scope).
 */
function tagFindingScopes(ctx: RunCtx): void {
  const scopedIds = new Set(ctx.inScope(ctx.store.all()).map((f) => f.id));
  for (const f of ctx.store.all()) {
    f.inScope = scopedIds.has(f.id);
    markScope(f, {
      ...ctx.config.fix,
      includeTests: ctx.config.includeTests,
      inChangedScope:
        f.inScope === true &&
        (!needsAllRepairFilesInScope(f) || allRepairFilesInScope(f, ctx.inScope)),
    });
  }
  for (const plan of plannedRepairs(ctx.store.all(), ctx.config, ctx.deps.cwd)) {
    applyRepairPlanToFinding(plan);
  }
}

/** Route report-only/deterministic findings into their accumulator maps. */
function collectRouted(ctx: RunCtx, findings: Finding[]): void {
  const routed = route(findings);
  for (const finding of routed.reportOnly) {
    if (finding.category === "secret") ctx.secrets.set(finding.id, finding);
    else ctx.reportOnly.set(finding.id, finding);
  }
  for (const finding of routed.deterministic) ctx.deterministic.set(finding.id, finding);
}

function emitAuditEvent(ctx: RunCtx, audited: AuditResult): void {
  const scopedFindings = ctx.inScope(audited.findings);
  // Eligibility is read off the store records: fresh findings are cloned into the store by
  // reconcile, and markScope marked those copies, not `audited.findings`.
  const funnel = auditEligibility(
    scopedFindings.map((f) => ctx.store.get(f.id) ?? f),
    Boolean(ctx.config.includeTests),
  );
  ctx.bus.emit({
    type: "audit",
    loop: ctx.loop,
    findings: scopedFindings.length,
    files: new Set(scopedFindings.map((f) => f.file)).size,
    scanned: audited.scanned,
    eligible: funnel.eligible,
    excluded: funnel.excluded,
  });
}

/** Either a stop reason, or the deterministic units to run this iteration. */
type WorkPlan = { kind: "stop"; termination: Termination } | { kind: "work"; deterministicWork: WorkUnit[] };

function planWork(ctx: RunCtx, audited: AuditResult): WorkPlan {
  if (ctx.loop === 1 && audited.findings.length === 0) return { kind: "stop", termination: "converged" };

  const pending = pendingUnderBudget(ctx.store, ctx.config.perIssueBudget);
  if (pending.length === 0) return { kind: "stop", termination: "converged" };

  const firstPlans = plannedRepairs(pending, ctx.config, ctx.deps.cwd);
  const deterministicWork = deterministicUnits(firstPlans);
  const aiWork = dispatchableUnits(firstPlans);
  if (deterministicWork.length === 0 && aiWork.length === 0) return { kind: "stop", termination: "no-progress" };

  return { kind: "work", deterministicWork };
}

/**
 * Deterministic units edit the REAL cwd (no sandbox, unlike AI units) and the gate runs a
 * whole-project typecheck. Running them concurrently let one unit's in-progress (or reverted)
 * edit fail a sibling unit's global tsc and false-revert a perfectly good fix. They are fast
 * (a delete / organize-imports / eslint --fix), so serializing them costs little and removes
 * the whole cross-unit interference class — only one deterministic edit is ever on disk at a
 * time when its gate runs.
 */
const DETERMINISTIC_CONCURRENCY = 1;

async function runDeterministicPhase(ctx: RunCtx, deterministicWork: WorkUnit[]): Promise<Set<string>> {
  const { bus, config, deps, store } = ctx;
  bus.emit({
    type: "loop-start",
    loop: ctx.loop,
    files: deterministicWork.map((u) => u.file),
    concurrency: DETERMINISTIC_CONCURRENCY,
    findings: deterministicWork.reduce((sum, u) => sum + u.findings.length, 0),
  });
  const deterministicFixUnit =
    deps.deterministicFixUnit ??
    (async (): Promise<FixOutcome> => ({
      kept: false,
      reason: "session-error",
      detail: "No deterministic fixer configured",
      usage: zeroUsage(),
    }));
  const outcomes = await dispatch(
    deterministicWork,
    async (unit) => {
      bus.emit({ type: "file-start", loop: ctx.loop, file: unit.file, rule: unit.findings[0]?.rule, model: "deterministic" });
      const outcome = await deterministicFixUnit(unit, ctx.loop);
      bus.emit({
        type: "file-result",
        loop: ctx.loop,
        file: unit.file,
        outcome: outcome.kept ? "fixed" : "reverted",
        findings: unit.findings.length,
        reason: outcome.reason,
        detail: outcome.detail,
      });
      return { unit, outcome };
    },
    { concurrency: DETERMINISTIC_CONCURRENCY, signal: deps.signal },
  );
  const deletedFiles = new Set<string>();
  for (const { unit, outcome } of outcomes) {
    applyOutcome(store, unit, outcome, config.perIssueBudget, (d) => logFindingDecision(ctx, d));
    if (outcome.usage) ctx.usage = addUsage(ctx.usage, outcome.usage);
    // A kept unused-file deletion removes the file from disk. Other scanners' findings on that
    // same file are now moot — record the deleted paths so the caller can resolve them before
    // dispatching AI work (otherwise an AI session edits a sandbox copy and its patch fails to
    // apply to the now-missing index entry — a wasted session + a spurious patch-conflict revert).
    if (outcome.kept) {
      for (const finding of unit.findings) {
        if (finding.rule === "unused-file") deletedFiles.add(finding.file);
      }
    }
  }
  const detFixed = outcomes.filter((o) => o.outcome.kept).length;
  const detReverted = outcomes.filter((o) => !o.outcome.kept).length;
  bus.emit({
    type: "loop-complete",
    loop: ctx.loop,
    fixed: detFixed,
    reverted: detReverted,
    remaining: pendingUnderBudget(store, config.perIssueBudget).length,
    estimatedCostUsd: ctx.usage.estimatedCostUsd,
  });
  return deletedFiles;
}

/**
 * Resolve any still-pending findings sitting on a file that the deterministic phase just deleted
 * as unused. The file is gone, so those findings are obviated — the next re-audit would drop them
 * anyway (reconcile marks absent findings `fixed`). Doing it now stops tend from dispatching an AI
 * session against a deleted file, which would burn a session and then fail to apply its patch
 * ("does not exist in index" → a spurious patch-conflict revert). The unused-file findings
 * themselves are already marked fixed by the delete unit and are skipped here.
 */
function resolveFindingsOnDeletedFiles(ctx: RunCtx, deletedFiles: Set<string>): void {
  if (deletedFiles.size === 0) return;
  for (const finding of ctx.store.all()) {
    if (finding.status !== "pending") continue;
    if (finding.rule === "unused-file") continue;
    if (!deletedFiles.has(finding.file)) continue;
    finding.status = "fixed";
    delete finding.revertReason;
    delete finding.revertDetail;
    delete finding.finalFailureClass;
    debug(
      ctx,
      "finding.obviated",
      `${finding.file} ${finding.tool}/${finding.rule} → fixed (file deleted as unused)`,
      { id: finding.id, file: finding.file, rule: finding.rule, tool: finding.tool },
    );
  }
}

/**
 * Fix one (sub-)unit; if a multi-finding batch still times out or regresses, reactively
 * split it into single-finding units and run those sequentially as a last resort.
 */
async function fixWithSplitFallback(ctx: RunCtx, work: WorkUnit): Promise<DispatchOutcome[]> {
  const { bus, config, deps } = ctx;
  bus.emit({ type: "file-start", loop: ctx.loop, file: work.file, rule: work.findings[0]?.rule, model: modelForUnit(work.findings, config) });
  const outcome = await deps.fixUnit(work, ctx.loop);
  const smaller = shouldSplitAfterFailure(work, outcome) ? splitUnit(work) : [];
  if (smaller.length > 0) {
    debug(
      ctx,
      "batch.split",
      `${work.file} reverted (${outcome.failureClass}) → splitting ${work.findings.length} findings into singles`,
      { file: work.file, failureClass: outcome.failureClass, findings: work.findings.length },
    );
  }
  if (smaller.length === 0) {
    bus.emit({
      type: "file-result",
      loop: ctx.loop,
      file: work.file,
      outcome: outcome.kept ? "fixed" : "reverted",
      findings: work.findings.length,
      reason: outcome.reason,
      detail: outcome.detail,
    });
    return [{ unit: work, outcome, apply: true }];
  }

  // Split-parent placeholder: its findings are re-attempted as the single-finding splits
  // below, so report 0 here to avoid double-counting against the stable denominator.
  bus.emit({
    type: "file-result",
    loop: ctx.loop,
    file: work.file,
    outcome: "left",
    findings: 0,
    reason: outcome.reason,
    detail: outcome.detail,
  });

  const splitOutcomes: DispatchOutcome[] = [{ unit: work, outcome, apply: false }];
  for (const split of smaller) {
    if (deps.signal?.aborted) break;
    bus.emit({ type: "file-start", loop: ctx.loop, file: split.file, rule: split.findings[0]?.rule, model: modelForUnit(split.findings, config) });
    const splitOutcome = await deps.fixUnit(split, ctx.loop);
    bus.emit({
      type: "file-result",
      loop: ctx.loop,
      file: split.file,
      outcome: splitOutcome.kept ? "fixed" : "reverted",
      findings: split.findings.length,
      reason: splitOutcome.reason,
      detail: splitOutcome.detail,
    });
    splitOutcomes.push({ unit: split, outcome: splitOutcome, apply: true });
    if (splitOutcome.failureClass === "rate-limit") break;
  }
  return splitOutcomes;
}

/**
 * Process a large file's findings in bounded SEQUENTIAL batches from the start so no
 * session is ever handed more than it can finish in the timeout, and the doomed
 * full-file batch never happens. Batches share the file, so they must run one after
 * another (never concurrently) or they would patch-conflict on the same file.
 */
async function processUnitBatches(ctx: RunCtx, unit: WorkUnit): Promise<DispatchOutcome[]> {
  const batches = chunkUnit(unit, FIX_BATCH_SIZE);
  const results: DispatchOutcome[] = [];
  for (const batch of batches) {
    if (ctx.deps.signal?.aborted) break;
    const batchResults = await fixWithSplitFallback(ctx, batch);
    results.push(...batchResults);
    if (batchResults.some((r) => r.outcome.failureClass === "rate-limit")) break;
  }
  return results;
}

/** Dispatch the AI fix units; returns whether a rate-limit was hit (retryable infrastructure). */
async function runAiPhase(ctx: RunCtx, units: WorkUnit[]): Promise<boolean> {
  const { bus, config, deps, store } = ctx;
  bus.emit({
    type: "loop-start",
    loop: ctx.loop,
    files: units.map((u) => u.file),
    concurrency: config.maxSessions,
    findings: units.reduce((sum, u) => sum + u.findings.length, 0),
  });
  const outcomesNested = await dispatch(
    units,
    (unit) => processUnitBatches(ctx, unit),
    { concurrency: config.maxSessions, signal: deps.signal },
  );
  const outcomes = outcomesNested.flat();
  for (const { unit, outcome, apply } of outcomes) {
    if (apply) applyOutcome(store, unit, outcome, config.perIssueBudget, (d) => logFindingDecision(ctx, d));
    if (outcome.usage) ctx.usage = addUsage(ctx.usage, outcome.usage);
  }

  const aiFixed = outcomes.filter((o) => o.apply && o.outcome.kept).length;
  const aiReverted = outcomes.filter((o) => o.apply && !o.outcome.kept).length;
  bus.emit({
    type: "loop-complete",
    loop: ctx.loop,
    fixed: aiFixed,
    reverted: aiReverted,
    remaining: pendingUnderBudget(store, config.perIssueBudget).length,
    estimatedCostUsd: ctx.usage.estimatedCostUsd,
  });

  return outcomes.some((o) => o.outcome.failureClass === "rate-limit");
}

/** Run one scan → fix → re-audit iteration; returns whether to stop (and why) or continue. */
async function runOneIteration(ctx: RunCtx): Promise<StepResult> {
  if (ctx.deps.signal?.aborted) return { kind: "stop", termination: "no-progress" };
  ctx.loop++;
  ctx.bus.emit({ type: "scan-start", loop: ctx.loop });

  const auditTools = auditToolsForLoop(ctx);
  if (auditTools) {
    const present = [...new Set(ctx.store.all().map((f) => f.tool))];
    const skipped = present.filter((tool) => !auditTools.includes(tool));
    debug(
      ctx,
      "audit.tools",
      `re-audit [${auditTools.join(", ") || "none"}]` + (skipped.length ? ` · skipped [${skipped.join(", ")}] (all findings out of fix scope)` : ""),
      { running: auditTools, skipped },
    );
  }
  const audited = await runAudit(ctx, auditTools);
  if (ctx.loop === 1 && audited.allScannersMissing) return { kind: "stop", termination: "no-scanners" };

  ctx.store.reconcile(audited.findings, ctx.loop, auditTools ? new Set(auditTools) : undefined);
  tagFindingScopes(ctx);
  collectRouted(ctx, audited.findings);
  emitAuditEvent(ctx, audited);

  const planned = planWork(ctx, audited);
  if (planned.kind === "stop") return { kind: "stop", termination: planned.termination };

  if (ctx.fixingLoops >= ctx.config.maxLoops) return { kind: "stop", termination: "max-loops" };

  ctx.fixingLoops++;
  const beforeAttemptState = statusAttemptSnapshot(ctx.store);

  if (planned.deterministicWork.length > 0) {
    const deletedFiles = await runDeterministicPhase(ctx, planned.deterministicWork);
    resolveFindingsOnDeletedFiles(ctx, deletedFiles);
  }

  const units = dispatchableUnits(
    plannedRepairs(pendingUnderBudget(ctx.store, ctx.config.perIssueBudget), ctx.config, ctx.deps.cwd),
  );
  if (units.length === 0) {
    if (statusAttemptSnapshot(ctx.store) === beforeAttemptState) return { kind: "stop", termination: "no-progress" };
    return { kind: "continue" };
  }

  const rateLimited = await runAiPhase(ctx, units);
  if (rateLimited) return { kind: "stop", termination: "retryable-infrastructure" };

  if (statusAttemptSnapshot(ctx.store) === beforeAttemptState) return { kind: "stop", termination: "no-progress" };
  return { kind: "continue" };
}

/** Drive iterations until one reports a stop reason, then return it. */
async function runFixLoop(ctx: RunCtx): Promise<Termination> {
  while (true) {
    const step = await runOneIteration(ctx);
    if (step.kind === "stop") return step.termination;
  }
}

/**
 * The scan → fix → re-audit loop. Terminates on the first of: converged (0 fixable),
 * no-progress (no dispatchable units or an attempted loop changed no attempt/status
 * state), per-issue budget exhaustion (mark unfixable, keep going), or max-loops.
 */
export async function orchestrate(deps: OrchestrateDeps): Promise<OrchestrateResult> {
  const { config } = deps;
  const ctx: RunCtx = {
    deps,
    config,
    inScope: deps.inScope ?? ((f) => f),
    bus: deps.bus ?? new EventBus(),
    store: new FindingStore(),
    secrets: new Map<string, Finding>(),
    reportOnly: new Map<string, Finding>(),
    deterministic: new Map<string, Finding>(),
    scannerStatuses: [],
    runScope: { type: "scoped" },
    usage: zeroUsage(),
    loop: 0,
    fixingLoops: 0,
  };

  const termination = await runFixLoop(ctx);

  const derived = deriveReportFields(ctx.store.all(), ctx.scannerStatuses, {
    includeTests: Boolean(config.includeTests),
    include: config.fix?.include ?? [],
    exclude: config.fix?.exclude ?? [],
    includeGenerated: Boolean(config.fix?.includeGenerated),
    includeFixtures: Boolean(config.fix?.includeFixtures),
  });
  const exitStatus = exitStatusFor(termination, derived.failureSummary);
  ctx.bus.emit({ type: "done", exitStatus });
  return buildResult(ctx, termination, exitStatus);
}

/** Map a termination + failure summary to the process exit status. */
function exitStatusFor(
  termination: Termination,
  failureSummary: Parameters<typeof hasBlockingFailure>[0],
): number {
  if (termination === "no-scanners") return 1;
  if (termination === "retryable-infrastructure") return 75;
  return hasBlockingFailure(failureSummary) ? 1 : 0;
}

function buildResult(ctx: RunCtx, termination: Termination, exitStatus: number): OrchestrateResult {
  const deterministicFindings = [...ctx.deterministic.values()];
  return {
    termination,
    loops: ctx.fixingLoops,
    exitStatus,
    findings: ctx.store.all(),
    secrets: [...ctx.secrets.values()],
    reportOnly: [...ctx.reportOnly.values()],
    deterministic: deterministicFindings,
    depBumps: deterministicFindings.filter((f) => f.category === "vuln-dep"),
    scannerStatuses: ctx.scannerStatuses,
    runScope: ctx.runScope,
    usage: ctx.usage,
  };
}
