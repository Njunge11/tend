import { FindingStore } from "./findings/store.js";
import { route } from "./findings/router.js";
import type { Finding } from "./findings/finding.js";
import type { ScannerStatus } from "./scanners/scanner.js";
import type { RevertReason } from "./gate/check.js";
import { dispatch, isTestFile, planWork, type WorkUnit } from "./fixing/dispatch.js";
import { EventBus } from "./output/events.js";

export type AuditResult = {
  findings: Finding[];
  allScannersMissing?: boolean;
  scanned?: number;
  scannerStatuses?: ScannerStatus[];
};
export type FixOutcome = { kept: boolean; reason?: RevertReason };

export type OrchestrateDeps = {
  /** Run the scanners for a loop and return normalized findings. */
  audit: (loop: number) => Promise<AuditResult>;
  /** Fix one work unit (session + gate); returns whether the fix was kept. */
  fixUnit: (unit: WorkUnit, loop: number) => Promise<FixOutcome>;
  config: { maxLoops: number; perIssueBudget: number; maxSessions: number; includeTests?: boolean };
  /** Restrict findings to the fix scope (changed files); defaults to all. */
  inScope?: (findings: Finding[]) => Finding[];
  bus?: EventBus;
};

export type Termination = "converged" | "max-loops" | "no-progress" | "no-scanners";

export type OrchestrateResult = {
  termination: Termination;
  loops: number;
  exitStatus: number;
  findings: Finding[];
  secrets: Finding[];
  depBumps: Finding[];
  scannerStatuses: ScannerStatus[];
};

/** AI-fixable findings still pending and under their retry budget. */
function pendingUnderBudget(store: FindingStore, budget: number): Finding[] {
  return store.query({ track: "ai-fix", status: "pending" }).filter((f) => f.attempts < budget);
}

function dispatchableUnits(findings: Finding[], includeTests: boolean | undefined): WorkUnit[] {
  // Group first so a code file's sibling test stays reserved on its unit, then (unless
  // --include-tests) drop units that exist only to fix a test file — test files are
  // excluded as primary fix targets, but remain editable as a sibling of their owner.
  return planWork(findings).filter((u) => includeTests || u.findings.some((f) => !isTestFile(f.file)));
}

function statusAttemptSnapshot(store: FindingStore): string {
  return store
    .all()
    .map((f) => `${f.id}:${f.status}:${f.attempts}`)
    .sort()
    .join("|");
}

function applyOutcome(store: FindingStore, unit: WorkUnit, outcome: FixOutcome, budget: number): void {
  for (const finding of unit.findings) {
    if (outcome.kept) {
      finding.status = "fixed";
    } else {
      store.recordFailedAttempt(finding.id, outcome.reason ?? "session-error");
      if (store.isBudgetExhausted(finding.id, budget)) finding.status = "unfixable";
    }
  }
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
  const depBumps = new Map<string, Finding>();

  let loop = 0;
  let fixingLoops = 0;
  let termination: Termination = "converged";
  let scannerStatuses: ScannerStatus[] = [];

  while (true) {
    loop++;
    bus.emit({ type: "scan-start", loop });
    const audited = await deps.audit(loop);
    scannerStatuses = audited.scannerStatuses ?? scannerStatuses;

    if (loop === 1 && audited.allScannersMissing) {
      bus.emit({ type: "done", exitStatus: 1 });
      return result("no-scanners", fixingLoops, 1, store, secrets, depBumps, scannerStatuses);
    }

    store.reconcile(audited.findings, loop);

    // Tag each tracked finding by fix scope so the summary can split "your changes" from
    // "repo-wide". `inScope` is identity under `--all` (everything in scope).
    const scopedIds = new Set(inScope(store.all()).map((f) => f.id));
    for (const f of store.all()) f.inScope = scopedIds.has(f.id);

    const routed = route(audited.findings);
    for (const s of routed.reportOnly) secrets.set(s.id, s);
    for (const d of routed.deterministic) depBumps.set(d.id, d);

    bus.emit({
      type: "audit",
      loop,
      findings: audited.findings.length,
      files: new Set(audited.findings.map((f) => f.file)).size,
      scanned: audited.scanned,
    });

    if (loop === 1 && audited.findings.length === 0) {
      termination = "converged";
      break;
    }

    const pending = pendingUnderBudget(store, config.perIssueBudget);
    const fixable = inScope(pending);

    if (pending.length === 0) {
      termination = "converged";
      break;
    }

    const units = dispatchableUnits(fixable, config.includeTests);
    if (units.length === 0) {
      termination = "no-progress";
      break;
    }

    if (fixingLoops >= config.maxLoops) {
      termination = "max-loops";
      break;
    }

    fixingLoops++;
    const beforeAttemptState = statusAttemptSnapshot(store);
    bus.emit({
      type: "loop-start",
      loop,
      files: units.map((u) => u.file),
      concurrency: config.maxSessions,
    });
    const outcomes = await dispatch(
      units,
      async (unit) => {
        bus.emit({ type: "file-start", loop, file: unit.file, rule: unit.findings[0]?.rule });
        const outcome = await deps.fixUnit(unit, loop);
        bus.emit({
          type: "file-result",
          loop,
          file: unit.file,
          outcome: outcome.kept ? "fixed" : "reverted",
          reason: outcome.reason,
        });
        return { unit, outcome };
      },
      { concurrency: config.maxSessions },
    );
    for (const { unit, outcome } of outcomes) applyOutcome(store, unit, outcome, config.perIssueBudget);

    bus.emit({ type: "loop-complete", loop, fixed: outcomes.filter((o) => o.outcome.kept).length });

    if (statusAttemptSnapshot(store) === beforeAttemptState) {
      termination = "no-progress";
      break;
    }
  }

  const exitStatus = secrets.size > 0 ? 1 : 0;
  bus.emit({ type: "done", exitStatus });
  return result(termination, fixingLoops, exitStatus, store, secrets, depBumps, scannerStatuses);
}

function result(
  termination: Termination,
  loops: number,
  exitStatus: number,
  store: FindingStore,
  secrets: Map<string, Finding>,
  depBumps: Map<string, Finding>,
  scannerStatuses: ScannerStatus[],
): OrchestrateResult {
  return {
    termination,
    loops,
    exitStatus: termination === "no-scanners" ? 1 : exitStatus,
    findings: store.all(),
    secrets: [...secrets.values()],
    depBumps: [...depBumps.values()],
    scannerStatuses,
  };
}
