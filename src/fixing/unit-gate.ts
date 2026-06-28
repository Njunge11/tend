import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding, Tool } from "../findings/finding.js";
import { antiRegression } from "../gate/checks/anti-regression.js";
import { antiSuppression } from "../gate/checks/anti-suppression.js";
import { typecheck } from "../gate/checks/typecheck.js";
import { runTestPhase, type TestOutcome } from "../gate/checks/tests.js";
import type { FixOutcome } from "../orchestrator.js";
import { zeroUsage, type AiUsage } from "../session/types.js";
import { isTestFile, type WorkUnit } from "./dispatch.js";
import type { FixStage } from "./progress.js";

export type UnitGateDeps = {
  cwd: string;
  typescript: boolean;
  runTsc: () => Promise<{ exitCode: number; output: string }>;
  /**
   * Normalized signatures of tsc errors that already existed on the pristine tree (captured once
   * before any fix). Passed through to the typecheck gate so pre-existing errors don't false-revert
   * a clean fix. `undefined` → no baseline captured → the gate fails closed on any tsc error.
   */
  typecheckBaseline?: readonly string[];
  runBuild?: () => Promise<{ exitCode: number; output: string }>;
  hasTestRunner: boolean;
  runRelated: (files: string[]) => Promise<TestOutcome[]>;
  scanFindings: (files: string[], tools?: Tool[]) => Promise<Finding[]>;
  baseline: Set<string>;
};

type FileSnapshot = Map<string, string | null>;

/** A file's current contents, or null if it doesn't exist. */
const snapshotFile = (abs: string): string | null => (existsSync(abs) ? readFileSync(abs, "utf8") : null);

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

/** Build a minimal multiset diff from captured before/after contents. */
export function buildDiff(before: FileSnapshot, after: FileSnapshot): string {
  const out: string[] = [];
  for (const [path, afterContent] of after) {
    const beforeLines = (before.get(path) ?? "").split("\n");
    const afterLines = (afterContent ?? "").split("\n");
    const beforeCounts = new Map<string, number>();
    for (const l of beforeLines) beforeCounts.set(l, (beforeCounts.get(l) ?? 0) + 1);
    const afterCounts = new Map<string, number>();
    for (const l of afterLines) afterCounts.set(l, (afterCounts.get(l) ?? 0) + 1);
    for (const [l, count] of beforeCounts) {
      const removed = count - (afterCounts.get(l) ?? 0);
      for (let i = 0; i < removed; i++) out.push(`-${l}`);
    }
    for (const [l, count] of afterCounts) {
      const added = count - (beforeCounts.get(l) ?? 0);
      for (let i = 0; i < added; i++) out.push(`+${l}`);
    }
  }
  return out.join("\n");
}

/**
 * jscpd duplicates that touch a test file are routed report-only and are never fixed (see
 * `planRepair` in repair-strategy.ts — test setup is meant to repeat). The gate must stay
 * consistent with that routing: when a source fix incidentally clones a block that also lives
 * in a sibling test, the new clone is something tend will never act on, so it must not count as
 * a regression and block an otherwise-good fix. Mirrors the routing predicate exactly. A
 * source↔source clone (no test side) is still a real regression and stays rejected.
 */
function isReportOnlyTestDuplicate(f: Finding): boolean {
  return (
    f.tool === "jscpd" &&
    f.rule === "duplicate-code" &&
    (isTestFile(f.file) || (f.flowPath ?? []).some((p) => isTestFile(p.file)))
  );
}

function isDeadCodeFinding(finding: Finding): boolean {
  return (
    finding.category === "dead-code" ||
    (finding.tool === "knip" && finding.rule.startsWith("unused-"))
  );
}

/**
 * Rules whose canonical remedy IS deletion: removing the flagged code is the fix, not a
 * suppression. A subclass constructor that only calls super (the rule's fix is "remove this
 * constructor") leaves nothing to add, so the correct fix arrives as a delete-only diff that
 * the anti-suppression heuristic would otherwise revert. The rest of the gate still verifies
 * such fixes the same as any other: typecheck, related tests, and the post-fix rescan that
 * proves the finding resolved without regressions.
 */
const DELETE_ONLY_FIX_RULES = new Set([
  "no-useless-constructor", // S6647
  "@typescript-eslint/no-useless-constructor", // S6647 (TS extension variant)
  "sonarjs/no-redundant-jump", // S3626 — remove the trailing continue/return
  "no-lone-blocks", // S1199 — remove the redundant braces
]);

/**
 * Rule-name traits whose canonical remedy is "remove the redundant construct" — the whole family
 * of `no-useless-*` / `no-redundant-*` / `no-unnecessary-*` / `no-extra-*` / `no-lone-*` / empty-*
 * rules, across plugins. Hand-curating every such rule (DELETE_ONLY_FIX_RULES) always lagged
 * reality, so a correct delete-only fix for, say, `sonarjs/no-redundant-optional` was false-flagged
 * as suppression and reverted, then retried 3×. Matching by trait covers the family. This only
 * widens which delete-only diffs SKIP the anti-suppression veto — the rest of the gate still
 * proves the fix (typecheck, related tests, and the rescan that the finding actually cleared), so a
 * deletion that breaks the build or doesn't resolve the finding is still reverted. Generic findings
 * (e.g. `eqeqeq`, which must be edited, not deleted) don't match and stay rejected when deleted.
 */
const DELETE_ONLY_RULE_TRAIT_PREFIXES = [
  "no-useless-",
  "no-redundant-",
  "no-unnecessary-",
  "no-extra-",
  "no-lone-",
  "no-empty",
];

/** The bare rule name with any leading plugin scope (e.g. `sonarjs/`, `@typescript-eslint/`) dropped. */
function bareRuleName(rule: string): string {
  const slash = rule.lastIndexOf("/");
  return slash >= 0 ? rule.slice(slash + 1) : rule;
}

function hasDeleteOnlyTrait(rule: string): boolean {
  const bare = bareRuleName(rule);
  return DELETE_ONLY_RULE_TRAIT_PREFIXES.some((prefix) => bare.startsWith(prefix));
}

function isDeleteOnlyFixable(finding: Finding): boolean {
  return (
    isDeadCodeFinding(finding) ||
    DELETE_ONLY_FIX_RULES.has(finding.rule) ||
    hasDeleteOnlyTrait(finding.rule)
  );
}

function allowsDeleteOnly(unit: WorkUnit): boolean {
  return unit.findings.length > 0 && unit.findings.every(isDeleteOnlyFixable);
}

type GateUnitOptions = {
  usage?: AiUsage;
  repair?: (attempt: number, regressed: TestOutcome[]) => Promise<void>;
  maxRepairs?: number;
  repairFailureDetail?: () => string | undefined;
  requireResolved?: boolean;
  onProgress?: (stage: FixStage, detail?: string) => void;
  /** Finding ids present before the fix (same scope as the post-fix rescan); see antiRegression. */
  preexistingIds?: ReadonlySet<string>;
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
  const tc = await typecheck({
    hasTsconfig: () => deps.typescript,
    runTsc: deps.runTsc,
    baselineErrors: deps.typecheckBaseline,
  });
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
      await (opts.repair ?? (() => Promise.resolve()))(attempt, regressed);
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
  // jscpd scans the whole repo, so a source fix can surface a new clone whose other foot lives in
  // a sibling test. Those are report-only and never fixed, so drop them before the regression check
  // (anti-regression compares ids only and would otherwise revert the good source fix).
  const afterFindings = (await deps.scanFindings(verificationTargets, scannerTools)).filter(
    (f) => !isReportOnlyTestDuplicate(f),
  );
  opts.onProgress?.("regression-check");
  const regression = antiRegression(unit.findings, afterFindings, {
    requireResolved: opts.requireResolved || unit.strategy === "multi-file-duplicate-refactor",
    baselineIds: opts.preexistingIds,
  });
  if (!regression.ok) return { kept: false, reason: regression.reason, detail: regression.detail, usage };

  return { kept: true, usage };
}
