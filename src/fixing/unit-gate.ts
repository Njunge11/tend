import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding, Tool } from "../findings/finding.js";
import { antiRegression } from "../gate/checks/anti-regression.js";
import { antiSuppression } from "../gate/checks/anti-suppression.js";
import { typecheck } from "../gate/checks/typecheck.js";
import { runTestPhase, type TestOutcome } from "../gate/checks/tests.js";
import type { FixOutcome } from "../orchestrator.js";
import { zeroUsage, type AiUsage } from "../session/types.js";
import type { WorkUnit } from "./dispatch.js";
import type { FixStage } from "./progress.js";

export type UnitGateDeps = {
  cwd: string;
  typescript: boolean;
  runTsc: () => Promise<{ exitCode: number; output: string }>;
  runBuild?: () => Promise<{ exitCode: number; output: string }>;
  hasTestRunner: boolean;
  runRelated: (files: string[]) => Promise<TestOutcome[]>;
  scanFindings: (files: string[], tools?: Tool[]) => Promise<Finding[]>;
  baseline: Set<string>;
};

export type FileSnapshot = Map<string, string | null>;

/** A file's current contents, or null if it doesn't exist. */
export const snapshotFile = (abs: string): string | null => (existsSync(abs) ? readFileSync(abs, "utf8") : null);

export function snapshotUnitFiles(cwd: string, files: string[]): FileSnapshot {
  return new Map(files.map((f) => [f, snapshotFile(join(cwd, f))] as const));
}

export function restoreSnapshot(cwd: string, before: FileSnapshot): void {
  for (const [f, original] of before) {
    const p = join(cwd, f);
    if (original === null) {
      if (existsSync(p)) rmSync(p, { force: true });
    } else {
      writeFileSync(p, original);
    }
  }
}

export function snapshotUnitNow(cwd: string, files: string[]): FileSnapshot {
  return snapshotUnitFiles(cwd, files);
}

export function unitChanged(cwd: string, files: string[], before: FileSnapshot): boolean {
  return files.some((f) => snapshotFile(join(cwd, f)) !== before.get(f));
}

/** Build a minimal unified diff from captured before/after contents. */
export function buildDiff(before: FileSnapshot, after: FileSnapshot): string {
  const out: string[] = [];
  for (const [path, afterContent] of after) {
    const beforeLines = (before.get(path) ?? "").split("\n");
    const afterLines = (afterContent ?? "").split("\n");
    for (const l of beforeLines) if (!afterLines.includes(l)) out.push(`-${l}`);
    for (const l of afterLines) if (!beforeLines.includes(l)) out.push(`+${l}`);
  }
  return out.join("\n");
}

function isDeadCodeFinding(finding: Finding): boolean {
  return (
    finding.category === "dead-code" ||
    (finding.tool === "knip" && finding.rule.startsWith("unused-"))
  );
}

export function allowsDeleteOnly(unit: WorkUnit): boolean {
  return unit.findings.length > 0 && unit.findings.every(isDeadCodeFinding);
}

type GateUnitOptions = {
  usage?: AiUsage;
  repair?: (attempt: number, regressed: TestOutcome[]) => Promise<void>;
  maxRepairs?: number;
  repairFailureDetail?: () => string | undefined;
  requireResolved?: boolean;
  onProgress?: (stage: FixStage, detail?: string) => void;
};

export async function gateUnitChanges(
  unit: WorkUnit,
  before: FileSnapshot,
  deps: UnitGateDeps,
  opts: GateUnitOptions = {},
): Promise<FixOutcome> {
  const usage = opts.usage ?? zeroUsage();
  const after = snapshotUnitNow(deps.cwd, unit.files);
  const scannerTools = [...new Set(unit.findings.map((finding) => finding.tool))];

  opts.onProgress?.("anti-suppression");
  const supp = antiSuppression(buildDiff(before, after), {
    allowDeleteOnly: allowsDeleteOnly(unit),
  });
  if (!supp.ok) return { kept: false, reason: supp.reason, detail: supp.detail, usage };

  opts.onProgress?.("typecheck");
  const tc = await typecheck({ hasTsconfig: () => deps.typescript, runTsc: deps.runTsc });
  if (!tc.ok) return { kept: false, reason: tc.reason, detail: tc.detail, usage };

  if (unit.strategy === "generated-source-repair" && deps.runBuild) {
    opts.onProgress?.("build");
    const build = await deps.runBuild();
    if (build.exitCode !== 0) {
      return {
        kept: false,
        reason: "typecheck",
        detail: `Build failed while regenerating generated artifact.\n${build.output}`.trim(),
        usage,
      };
    }
  }

  const phase = await runTestPhase({
    baseline: deps.baseline,
    runRelated: () => {
      opts.onProgress?.("related-tests");
      return deps.runRelated(unit.files);
    },
    repair: async (attempt, regressed) => {
      opts.onProgress?.("test-repair", `${attempt}/${opts.maxRepairs ?? 0}`);
      await (opts.repair ?? (async () => {}))(attempt, regressed);
    },
    maxRepairs: opts.maxRepairs ?? 0,
    hasTestRunner: deps.hasTestRunner,
  });
  if (!phase.ok) {
    return {
      kept: false,
      reason: phase.reason,
      detail: opts.repairFailureDetail?.() ?? phase.detail,
      usage,
    };
  }

  const verificationTargets = unit.verificationTargets ?? unit.files;
  opts.onProgress?.("rescan");
  const afterFindings = await deps.scanFindings(verificationTargets, scannerTools);
  opts.onProgress?.("regression-check");
  const regression = antiRegression(unit.findings, afterFindings, {
    requireResolved: opts.requireResolved || unit.strategy === "multi-file-duplicate-refactor",
  });
  if (!regression.ok) return { kept: false, reason: regression.reason, detail: regression.detail, usage };

  return { kept: true, usage };
}
