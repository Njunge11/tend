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
import { addUsage, zeroUsage, type AiUsage, type FailureClass } from "./session/types.js";
import type { RunScope } from "./report/schema.js";
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
  };
  /** Restrict findings to the fix scope (changed files); defaults to all. */
  inScope?: (findings: Finding[]) => Finding[];
  bus?: EventBus;
};

export type Termination =
  | "converged"
  | "max-loops"
  | "no-progress"
  | "no-scanners"
  | "retryable-infrastructure";

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

function dispatchableUnits(plans: RepairPlan[]): WorkUnit[] {
  return planWorkFromRepairs(plans).filter((unit) => unit.strategy !== undefined && isAiDispatchStrategy(unit.strategy));
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

function applyOutcome(store: FindingStore, unit: WorkUnit, outcome: FixOutcome, budget: number): void {
  for (const finding of unit.findings) {
    if (outcome.kept) {
      finding.status = "fixed";
      delete finding.revertReason;
      delete finding.revertDetail;
      delete finding.finalFailureClass;
    } else {
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
 * The scan → fix → re-audit loop. Terminates on the first of: converged (0 fixable),
 * no-progress (no dispatchable units or an attempted loop changed no attempt/status
 * state), per-issue budget exhaustion (mark unfixable, keep going), or max-loops.
 */
export async function orchestrate(deps: OrchestrateDeps): Promise<OrchestrateResult> {
  const { config } = deps;
  const inScope = deps.inScope ?? ((f) => f);
  const bus = deps.bus ?? new EventBus();
  const store = new FindingStore();

  const secrets = new Map<string, Finding>();
  const reportOnly = new Map<string, Finding>();
  const deterministic = new Map<string, Finding>();

  let loop = 0;
  let fixingLoops = 0;
  let termination: Termination = "converged";
  let scannerStatuses: ScannerStatus[] = [];
  let runScope: RunScope = { type: "scoped" };
  // Estimated AI cost/usage accumulates across every fix outcome, including reverted ones.
  let usage = zeroUsage();

  while (true) {
    loop++;
    bus.emit({ type: "scan-start", loop });
    const relevantTools = loop > 1 ? ([...new Set(store.all().map((f) => f.tool))] as Tool[]) : undefined;
    const audited = await deps.audit(loop, relevantTools);
    scannerStatuses = audited.scannerStatuses ?? scannerStatuses;
    if (loop === 1) {
      runScope =
        audited.scanned == null
          ? { type: "all" }
          : { type: "scoped", fileCount: audited.scanned };
    }

    if (loop === 1 && audited.allScannersMissing) {
      bus.emit({ type: "done", exitStatus: 1 });
      return result(
        "no-scanners",
        fixingLoops,
        1,
        store,
        secrets,
        reportOnly,
        deterministic,
        scannerStatuses,
        runScope,
        usage,
      );
    }

    store.reconcile(audited.findings, loop);

    // Tag each tracked finding by fix scope so the summary can split "your changes" from
    // "repo-wide". `inScope` is identity under `--all` (everything in scope).
    const scopedIds = new Set(inScope(store.all()).map((f) => f.id));
    for (const f of store.all()) {
      f.inScope = scopedIds.has(f.id);
      markScope(f, {
        ...config.fix,
        includeTests: config.includeTests,
        inChangedScope:
          f.inScope === true &&
          (!needsAllRepairFilesInScope(f) || allRepairFilesInScope(f, inScope)),
      });
    }
    for (const plan of plannedRepairs(store.all(), config, deps.cwd)) {
      applyRepairPlanToFinding(plan);
    }

    const scopedFindings = inScope(audited.findings);
    const routed = route(audited.findings);
    for (const finding of routed.reportOnly) {
      if (finding.category === "secret") secrets.set(finding.id, finding);
      else reportOnly.set(finding.id, finding);
    }
    for (const finding of routed.deterministic) deterministic.set(finding.id, finding);

    bus.emit({
      type: "audit",
      loop,
      findings: scopedFindings.length,
      files: new Set(scopedFindings.map((f) => f.file)).size,
      scanned: audited.scanned,
    });

    if (loop === 1 && audited.findings.length === 0) {
      termination = "converged";
      break;
    }

    const pending = pendingUnderBudget(store, config.perIssueBudget);

    if (pending.length === 0) {
      termination = "converged";
      break;
    }

    const firstPlans = plannedRepairs(pending, config, deps.cwd);
    const deterministicWork = deterministicUnits(firstPlans);
    const aiWork = dispatchableUnits(firstPlans);
    if (deterministicWork.length === 0 && aiWork.length === 0) {
      termination = "no-progress";
      break;
    }

    if (fixingLoops >= config.maxLoops) {
      termination = "max-loops";
      break;
    }

    fixingLoops++;
    const beforeAttemptState = statusAttemptSnapshot(store);

    if (deterministicWork.length > 0) {
      bus.emit({
        type: "loop-start",
        loop,
        files: deterministicWork.map((u) => u.file),
        concurrency: config.maxSessions,
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
          bus.emit({ type: "file-start", loop, file: unit.file, rule: unit.findings[0]?.rule });
          const outcome = await deterministicFixUnit(unit, loop);
          bus.emit({
            type: "file-result",
            loop,
            file: unit.file,
            outcome: outcome.kept ? "fixed" : "reverted",
            reason: outcome.reason,
            detail: outcome.detail,
          });
          return { unit, outcome };
        },
        { concurrency: config.maxSessions },
      );
      for (const { unit, outcome } of outcomes) {
        applyOutcome(store, unit, outcome, config.perIssueBudget);
        if (outcome.usage) usage = addUsage(usage, outcome.usage);
      }
      const detFixed = outcomes.filter((o) => o.outcome.kept).length;
      const detReverted = outcomes.filter((o) => !o.outcome.kept).length;
      bus.emit({
        type: "loop-complete",
        loop,
        fixed: detFixed,
        reverted: detReverted,
        remaining: pendingUnderBudget(store, config.perIssueBudget).length,
        estimatedCostUsd: usage.estimatedCostUsd,
      });
    }

    const units = dispatchableUnits(plannedRepairs(pendingUnderBudget(store, config.perIssueBudget), config, deps.cwd));
    if (units.length === 0) {
      if (statusAttemptSnapshot(store) === beforeAttemptState) {
        termination = "no-progress";
        break;
      }
      continue;
    }

    bus.emit({
      type: "loop-start",
      loop,
      files: units.map((u) => u.file),
      concurrency: config.maxSessions,
    });
    type DispatchOutcome = { unit: WorkUnit; outcome: FixOutcome; apply: boolean };

    // Fix one (sub-)unit; if a multi-finding batch still times out or regresses, reactively
    // split it into single-finding units and run those sequentially as a last resort.
    const fixWithSplitFallback = async (work: WorkUnit): Promise<DispatchOutcome[]> => {
      bus.emit({ type: "file-start", loop, file: work.file, rule: work.findings[0]?.rule });
      const outcome = await deps.fixUnit(work, loop);
      const smaller = shouldSplitAfterFailure(work, outcome) ? splitUnit(work) : [];
      if (smaller.length === 0) {
        bus.emit({
          type: "file-result",
          loop,
          file: work.file,
          outcome: outcome.kept ? "fixed" : "reverted",
          reason: outcome.reason,
          detail: outcome.detail,
        });
        return [{ unit: work, outcome, apply: true }];
      }

      bus.emit({
        type: "file-result",
        loop,
        file: work.file,
        outcome: "left",
        reason: outcome.reason,
        detail: outcome.detail,
      });

      const splitOutcomes: DispatchOutcome[] = [{ unit: work, outcome, apply: false }];
      for (const split of smaller) {
        bus.emit({ type: "file-start", loop, file: split.file, rule: split.findings[0]?.rule });
        const splitOutcome = await deps.fixUnit(split, loop);
        bus.emit({
          type: "file-result",
          loop,
          file: split.file,
          outcome: splitOutcome.kept ? "fixed" : "reverted",
          reason: splitOutcome.reason,
          detail: splitOutcome.detail,
        });
        splitOutcomes.push({ unit: split, outcome: splitOutcome, apply: true });
        if (splitOutcome.failureClass === "rate-limit") break;
      }
      return splitOutcomes;
    };

    const outcomesNested = await dispatch(
      units,
      async (unit): Promise<DispatchOutcome[]> => {
        // Process a large file's findings in bounded SEQUENTIAL batches from the start so no
        // session is ever handed more than it can finish in the timeout, and the doomed
        // full-file batch never happens. Batches share the file, so they must run one after
        // another (never concurrently) or they would patch-conflict on the same file.
        const batches = chunkUnit(unit, FIX_BATCH_SIZE);
        const results: DispatchOutcome[] = [];
        for (const batch of batches) {
          const batchResults = await fixWithSplitFallback(batch);
          results.push(...batchResults);
          if (batchResults.some((r) => r.outcome.failureClass === "rate-limit")) break;
        }
        return results;
      },
      { concurrency: config.maxSessions },
    );
    const outcomes = outcomesNested.flat();
    for (const { unit, outcome, apply } of outcomes) {
      if (apply) applyOutcome(store, unit, outcome, config.perIssueBudget);
      if (outcome.usage) usage = addUsage(usage, outcome.usage);
    }

    const aiFixed = outcomes.filter((o) => o.apply && o.outcome.kept).length;
    const aiReverted = outcomes.filter((o) => o.apply && !o.outcome.kept).length;
    bus.emit({
      type: "loop-complete",
      loop,
      fixed: aiFixed,
      reverted: aiReverted,
      remaining: pendingUnderBudget(store, config.perIssueBudget).length,
      estimatedCostUsd: usage.estimatedCostUsd,
    });

    if (outcomes.some((o) => o.outcome.failureClass === "rate-limit")) {
      termination = "retryable-infrastructure";
      break;
    }

    if (statusAttemptSnapshot(store) === beforeAttemptState) {
      termination = "no-progress";
      break;
    }
  }

  const derived = deriveReportFields(store.all(), scannerStatuses, {
    includeTests: Boolean(config.includeTests),
    include: config.fix?.include ?? [],
    exclude: config.fix?.exclude ?? [],
    includeGenerated: Boolean(config.fix?.includeGenerated),
    includeFixtures: Boolean(config.fix?.includeFixtures),
  });
  const hasBlockingFailure =
    derived.failureSummary.blockingSecrets > 0 ||
    derived.failureSummary.unresolvedEligible > 0 ||
    derived.failureSummary.toolFailures > 0 ||
    derived.failureSummary.failedDeterministic > 0 ||
    derived.failureSummary.sessionErrors > 0 ||
    derived.failureSummary.regressions > 0 ||
    derived.failureSummary.typecheckFailures > 0 ||
    derived.failureSummary.testFailures > 0;
  const exitStatus =
    termination === "retryable-infrastructure"
      ? 75
      : hasBlockingFailure
        ? 1
        : 0;
  bus.emit({ type: "done", exitStatus });
  return result(
    termination,
    fixingLoops,
    exitStatus,
    store,
    secrets,
    reportOnly,
    deterministic,
    scannerStatuses,
    runScope,
    usage,
  );
}

function result(
  termination: Termination,
  loops: number,
  exitStatus: number,
  store: FindingStore,
  secrets: Map<string, Finding>,
  reportOnly: Map<string, Finding>,
  deterministic: Map<string, Finding>,
  scannerStatuses: ScannerStatus[],
  runScope: RunScope,
  usage: AiUsage,
): OrchestrateResult {
  return {
    termination,
    loops,
    exitStatus: termination === "no-scanners" ? 1 : exitStatus,
    findings: store.all(),
    secrets: [...secrets.values()],
    reportOnly: [...reportOnly.values()],
    deterministic: [...deterministic.values()],
    depBumps: [...deterministic.values()].filter((f) => f.category === "vuln-dep"),
    scannerStatuses,
    runScope,
    usage,
  };
}
