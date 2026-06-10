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
    .sort()
    .join("|");
}

function classFromOutcome(outcome: FixOutcome): FailureClass | undefined {
  if (outcome.failureClass) return outcome.failureClass;
  switch (outcome.reason) {
    case "regression":
      return "regression";
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
  return outcome.failureClass === "tool-timeout" || outcome.failureClass === "no-op";
}

/**
 * Gate failures (regression/typecheck/broke-test) already ran an in-dispatch repair session
 * before reverting (see `runRegressionRepair`/the gate's test-repair window in fix-unit.ts).
 * Re-dispatching the whole unit from scratch repeats that expensive work and almost never
 * succeeds, so cap these classes at a single re-dispatch instead of burning the full per-issue
 * budget — bounding worst-case wall-clock from ~budget×(initial+repair) to ~2×.
 */
const LIMITED_RETRY_FAILURE_CLASSES: ReadonlySet<FailureClass> = new Set([
  "regression",
  "typecheck",
  "broke-test",
]);
const LIMITED_RETRY_BUDGET = 2;

function effectiveBudget(failureClass: FailureClass | undefined, budget: number): number {
  return failureClass && LIMITED_RETRY_FAILURE_CLASSES.has(failureClass)
    ? Math.min(LIMITED_RETRY_BUDGET, budget)
    : budget;
}

/** Record one reverted/failed outcome against a finding (budget-aware). */
function applyFailedOutcome(store: FindingStore, finding: Finding, outcome: FixOutcome, budget: number): void {
  const reason = outcome.reason ?? "session-error";
  const failureClass = classFromOutcome(outcome);
  if (failureClass === "rate-limit") {
    store.recordFailureWithoutAttempt(finding.id, reason, outcome.detail, failureClass);
  } else if (isTerminalNoBurnFailure(outcome)) {
    store.recordFailureWithoutAttempt(finding.id, reason, outcome.detail, failureClass!);
    finding.status = "unfixable";
  } else {
    store.recordFailedAttempt(finding.id, reason, outcome.detail, failureClass);
    if (store.isBudgetExhausted(finding.id, effectiveBudget(failureClass, budget)))
      finding.status = "unfixable";
  }
}

export function applyOutcome(store: FindingStore, unit: WorkUnit, outcome: FixOutcome, budget: number): void {
  for (const finding of unit.findings) {
    if (outcome.kept) {
      // Defense in depth: a kept unit only ever targeted its in-scope findings. Never credit an
      // out-of-fix-scope (report-only) finding as fixed even if one reaches a kept unit by some
      // other path — leave its status untouched (stays pending) so the report can't show it fixed.
      if (finding.inFixScope === false) continue;
      finding.status = "fixed";
      delete finding.revertReason;
      delete finding.revertDetail;
      delete finding.finalFailureClass;
    } else {
      applyFailedOutcome(store, finding, outcome, budget);
    }
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

function shouldSplitAfterFailure(unit: WorkUnit, outcome: FixOutcome): boolean {
  return unit.findings.length > 1 && (outcome.failureClass === "tool-timeout" || outcome.failureClass === "regression");
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

/** One loop iteration's verdict: stop the run with a reason, or run another iteration. */
type StepResult = { kind: "stop"; termination: Termination } | { kind: "continue" };

/** Re-audit (subset of scanners after loop 1) and record scanner statuses / run scope. */
async function runAudit(ctx: RunCtx): Promise<AuditResult> {
  const relevantTools = ctx.loop > 1 ? ([...new Set(ctx.store.all().map((f) => f.tool))] as Tool[]) : undefined;
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

async function runDeterministicPhase(ctx: RunCtx, deterministicWork: WorkUnit[]): Promise<void> {
  const { bus, config, deps, store } = ctx;
  bus.emit({
    type: "loop-start",
    loop: ctx.loop,
    files: deterministicWork.map((u) => u.file),
    concurrency: config.maxSessions,
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
    { concurrency: config.maxSessions, signal: deps.signal },
  );
  for (const { unit, outcome } of outcomes) {
    applyOutcome(store, unit, outcome, config.perIssueBudget);
    if (outcome.usage) ctx.usage = addUsage(ctx.usage, outcome.usage);
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
    if (apply) applyOutcome(store, unit, outcome, config.perIssueBudget);
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

  const audited = await runAudit(ctx);
  if (ctx.loop === 1 && audited.allScannersMissing) return { kind: "stop", termination: "no-scanners" };

  ctx.store.reconcile(audited.findings, ctx.loop);
  tagFindingScopes(ctx);
  collectRouted(ctx, audited.findings);
  emitAuditEvent(ctx, audited);

  const planned = planWork(ctx, audited);
  if (planned.kind === "stop") return { kind: "stop", termination: planned.termination };

  if (ctx.fixingLoops >= ctx.config.maxLoops) return { kind: "stop", termination: "max-loops" };

  ctx.fixingLoops++;
  const beforeAttemptState = statusAttemptSnapshot(ctx.store);

  if (planned.deterministicWork.length > 0) await runDeterministicPhase(ctx, planned.deterministicWork);

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
