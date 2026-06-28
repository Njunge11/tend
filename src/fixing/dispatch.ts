import PQueue from "p-queue";
import type { Finding } from "../findings/finding.js";
import type { RepairPlan, RepairStrategy } from "./repair-strategy.js";

export type WorkUnit = {
  /** The code file this unit owns (the group key). */
  file: string;
  /** Every file this worker reserves — the code file plus any sibling test. */
  files: string[];
  findings: Finding[];
  strategy?: RepairStrategy;
  strategies?: RepairStrategy[];
  verificationTargets?: string[];
};

const TEST_FILE_RE = /^(.*)\.(test|spec)\.([cm]?[jt]sx?)$/;

/** Whether a repo-relative path is a test file (`*.test.*` / `*.spec.*`). */
export const isTestFile = (file: string): boolean => TEST_FILE_RE.test(file);

/** A test file's owning code file (so both go to the same worker); else the file itself. */
function ownerOf(file: string): string {
  const m = TEST_FILE_RE.exec(file);
  return m ? `${m[1]}.${m[3]}` : file;
}

/**
 * Group findings into work units so each worker owns a disjoint set of files
 * (a code file plus its sibling test). No two sessions ever touch the same file.
 */
export function planWork(findings: Finding[]): WorkUnit[] {
  const byOwner = new Map<string, WorkUnit>();

  for (const finding of findings) {
    const owner = ownerOf(finding.file);
    let unit = byOwner.get(owner);
    if (!unit) {
      unit = { file: owner, files: [], findings: [] };
      byOwner.set(owner, unit);
    }
    unit.findings.push(finding);
    if (!unit.files.includes(finding.file)) unit.files.push(finding.file);
    if (!unit.files.includes(owner)) unit.files.push(owner);
  }

  return [...byOwner.values()];
}

/**
 * Strategies whose findings must be fixed together in a single session and therefore must
 * never be chunked: a duplicate refactor edits both clone sites and a shared module at once,
 * and a generated-source repair edits the source then regenerates the artifact.
 */
const ATOMIC_STRATEGIES: ReadonlySet<RepairStrategy> = new Set([
  "multi-file-duplicate-refactor",
  "generated-source-repair",
]);

function isAtomicUnit(unit: WorkUnit): boolean {
  const strategies = unit.strategies ?? (unit.strategy ? [unit.strategy] : []);
  return strategies.some((strategy) => ATOMIC_STRATEGIES.has(strategy));
}

/**
 * Split one unit's findings into sequential batches of at most `batchSize`, so no single AI
 * session is ever handed more findings than it can fix inside the session timeout (root cause
 * A: a 25-finding unit could not finish in the 10-min cap, burning a guaranteed timeout). The
 * unit is returned unchanged when it is atomic (its findings must be fixed together) or already
 * within `batchSize`. Every batch keeps the unit's file set, so the batches all own the same
 * file and MUST run sequentially — running them concurrently would have two sessions edit the
 * same file and conflict on patch apply (the no-two-sessions-touch-the-same-file invariant).
 */
export function chunkUnit(unit: WorkUnit, batchSize: number): WorkUnit[] {
  if (batchSize < 1 || unit.findings.length <= batchSize || isAtomicUnit(unit)) return [unit];
  const batches: WorkUnit[] = [];
  for (let index = 0; index < unit.findings.length; index += batchSize) {
    batches.push({
      ...unit,
      findings: unit.findings.slice(index, index + batchSize),
      files: [...unit.files],
      verificationTargets: unit.verificationTargets ? [...unit.verificationTargets] : undefined,
      strategies: unit.strategies ? [...unit.strategies] : undefined,
    });
  }
  return batches;
}

function strategyPriority(strategy: RepairStrategy | undefined): number {
  switch (strategy) {
    case "multi-file-duplicate-refactor":
      return 6;
    case "generated-source-repair":
      return 5;
    case "test-file-repair":
      return 4;
    case "dead-code-cleanup":
    case "single-file-ai-edit":
      return 3;
    case "deterministic-package-json-cleanup":
    case "deterministic-ts-organize-imports":
    case "deterministic-eslint-fix":
      return 2;
    default:
      return 0;
  }
}

function addUnique<T>(target: T[], values: T[]): void {
  for (const value of values) {
    if (!target.includes(value)) target.push(value);
  }
}

function ownerFiles(plan: RepairPlan): string[] {
  const files = plan.editableFiles.length > 0 ? plan.editableFiles : [plan.finding.file];
  if (plan.strategy === "multi-file-duplicate-refactor" || plan.strategy === "generated-source-repair") {
    return files;
  }
  return uniqueValues(files.flatMap((file) => [file, ownerOf(file)]));
}

function uniqueValues<T>(files: T[]): T[] {
  return [...new Set(files)];
}

function unitForPlan(plan: RepairPlan): WorkUnit {
  const files = ownerFiles(plan);
  return {
    file: plan.strategy === "test-file-repair" ? ownerOf(plan.finding.file) : files[0] ?? plan.finding.file,
    files,
    findings: [plan.finding],
    strategy: plan.strategy,
    strategies: [plan.strategy],
    verificationTargets: uniqueValues(plan.verificationTargets),
  };
}

function overlaps(a: WorkUnit, b: WorkUnit): boolean {
  const files = new Set(a.files);
  return b.files.some((file) => files.has(file));
}

function mergeUnits(a: WorkUnit, b: WorkUnit): WorkUnit {
  const strategies = uniqueValues<RepairStrategy>([
    ...(a.strategies ?? (a.strategy ? [a.strategy] : [])),
    ...(b.strategies ?? (b.strategy ? [b.strategy] : [])),
  ]);
  addUnique(a.files, b.files);
  addUnique(a.findings, b.findings);
  addUnique(a.verificationTargets ?? (a.verificationTargets = []), b.verificationTargets ?? []);
  a.strategy = strategies.toSorted((left, right) => strategyPriority(right) - strategyPriority(left))[0];
  a.strategies = strategies;
  if (!a.files.includes(a.file)) a.file = a.files[0] ?? a.file;
  return a;
}

/** A unit whose only job is deleting unused files (no other strategy mixed in). */
function isPureUnusedFileDelete(unit: WorkUnit): boolean {
  const strategies = unit.strategies ?? (unit.strategy ? [unit.strategy] : []);
  return strategies.length === 1 && strategies[0] === "deterministic-unused-file-delete";
}

/**
 * Collapse every unused-file deletion into ONE unit so the whole dead set is removed together
 * and typechecked once. Knip-flagged dead files frequently reference each other (a tRPC
 * client/server/query-client cluster, a db barrel + its index); deleting them in separate
 * concurrent units made each unit's typecheck transiently see a sibling that another unit had
 * just removed — a false "file not found" that reverted a perfectly good deletion at random.
 * Deleting them atomically is also safer: if removing the set genuinely breaks typecheck, the
 * whole batch reverts rather than leaving the tree half-deleted.
 */
function coalesceUnusedFileDeletes(units: WorkUnit[]): WorkUnit[] {
  const deletes = units.filter(isPureUnusedFileDelete);
  if (deletes.length <= 1) return units;
  const [first, ...rest] = deletes as [WorkUnit, ...WorkUnit[]];
  for (const unit of rest) mergeUnits(first, unit);
  const dropped = new Set(rest);
  return units.filter((unit) => !dropped.has(unit));
}

/**
 * Group planned repairs into disjoint work units. Unlike `planWork`, this honors
 * planner-selected editable files, so cross-file duplicate plans reserve both clone sites.
 */
export function planWorkFromRepairs(plans: RepairPlan[]): WorkUnit[] {
  const units: WorkUnit[] = [];

  for (const plan of plans) {
    let next = unitForPlan(plan);
    let merged = true;
    while (merged) {
      merged = false;
      for (let index = 0; index < units.length; index++) {
        if (!overlaps(units[index]!, next)) continue;
        next = mergeUnits(units[index]!, next);
        units.splice(index, 1);
        merged = true;
        break;
      }
    }
    units.push(next);
  }

  return coalesceUnusedFileDeletes(units);
}

/**
 * Run each work unit through `runUnit`, capped at `concurrency` concurrent sessions.
 * Units not yet started when `opts.signal` aborts are skipped — they produce no outcome
 * (so they can never be recorded as fixed) and no new session is spawned for them.
 */
export async function dispatch<T>(
  units: WorkUnit[],
  runUnit: (unit: WorkUnit) => Promise<T>,
  opts: { concurrency: number; signal?: AbortSignal },
): Promise<T[]> {
  const queue = new PQueue({ concurrency: opts.concurrency });
  const skipped = Symbol("skipped");
  const settled = await Promise.all(
    units.map(
      (unit) =>
        queue.add(
          async (): Promise<T | typeof skipped> => (opts.signal?.aborted ? skipped : runUnit(unit)),
        ) as Promise<T | typeof skipped>,
    ),
  );
  return settled.filter((result) => result !== skipped) as T[];
}
