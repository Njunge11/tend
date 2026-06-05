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
  const m = file.match(TEST_FILE_RE);
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
  a.strategy = strategies.sort((left, right) => strategyPriority(right) - strategyPriority(left))[0];
  a.strategies = strategies;
  if (!a.files.includes(a.file)) a.file = a.files[0] ?? a.file;
  return a;
}

/**
 * Group planned repairs into disjoint work units. Unlike `planWork`, this honors
 * planner-selected editable files, so cross-file duplicate plans reserve both clone sites.
 */
export function planWorkFromRepairs(plans: RepairPlan[]): WorkUnit[] {
  const units: WorkUnit[] = [];

  for (const plan of plans) {
    let next = unitForPlan(plan);
    for (let index = 0; index < units.length; index++) {
      if (!overlaps(units[index]!, next)) continue;
      next = mergeUnits(units[index]!, next);
      units.splice(index, 1);
      index = -1;
    }
    units.push(next);
  }

  return units;
}

/** Run each work unit through `runUnit`, capped at `concurrency` concurrent sessions. */
export async function dispatch<T>(
  units: WorkUnit[],
  runUnit: (unit: WorkUnit) => Promise<T>,
  opts: { concurrency: number },
): Promise<T[]> {
  const queue = new PQueue({ concurrency: opts.concurrency });
  return Promise.all(units.map((unit) => queue.add(() => runUnit(unit)) as Promise<T>));
}
