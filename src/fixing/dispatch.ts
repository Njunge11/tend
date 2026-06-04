import PQueue from "p-queue";
import type { Finding } from "../findings/finding.js";

export type WorkUnit = {
  /** The code file this unit owns (the group key). */
  file: string;
  /** Every file this worker reserves — the code file plus any sibling test. */
  files: string[];
  findings: Finding[];
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

/** Run each work unit through `runUnit`, capped at `concurrency` concurrent sessions. */
export async function dispatch<T>(
  units: WorkUnit[],
  runUnit: (unit: WorkUnit) => Promise<T>,
  opts: { concurrency: number },
): Promise<T[]> {
  const queue = new PQueue({ concurrency: opts.concurrency });
  return Promise.all(units.map((unit) => queue.add(() => runUnit(unit)) as Promise<T>));
}
