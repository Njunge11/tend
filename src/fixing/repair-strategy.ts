import { dirname, basename, join } from "node:path";
import type { Finding, ScopeExclusionReason } from "../findings/finding.js";
import { classifyScope, type FixScopeConfig } from "../scanners/scope-policy.js";
import { isTestFile } from "./dispatch.js";
import { isGeneratedArtifact, resolveGeneratedSourceOwner } from "./generated-source.js";

export const REPAIR_STRATEGIES = [
  "deterministic-eslint-fix",
  "deterministic-ts-organize-imports",
  "deterministic-package-json-cleanup",
  "single-file-ai-edit",
  "multi-file-duplicate-refactor",
  "generated-source-repair",
  "test-file-repair",
  "dead-code-cleanup",
  "unsupported",
] as const;

export type RepairStrategy = (typeof REPAIR_STRATEGIES)[number];

export type RepairStrategyReason =
  | ScopeExclusionReason
  | "generated-source-not-found"
  | "report-only"
  | "deterministic-not-dispatched";

export type RepairPlannerInput = {
  finding: Finding;
  scope?: Partial<Pick<Finding, "inFixScope" | "scopeExclusionReason" | "inReportScope" | "inScope">>;
  config?: FixScopeConfig & {
    eslintAutofixableRules?: string[];
  };
  cwd?: string;
  flowPath?: Finding["flowPath"];
  file?: string;
  category?: Finding["category"];
  rule?: string;
  tool?: Finding["tool"];
};

export type RepairPlan = {
  finding: Finding;
  strategy: RepairStrategy;
  editableFiles: string[];
  verificationTargets: string[];
  reason?: RepairStrategyReason;
};

const AUTO_FIX_RE = /\b(auto-?fix(?:able)?|eslint\s+--fix|fixable)\b/i;
const UNUSED_IMPORT_RE = /(^|[/@])no-unused-imports?$|unused[- ]imports?/i;

function unique(files: string[]): string[] {
  return [...new Set(files)];
}

function flowFiles(input: RepairPlannerInput): string[] {
  return unique([input.file ?? input.finding.file, ...(input.flowPath ?? input.finding.flowPath ?? []).map((step) => step.file)]);
}

function defaultPathReason(file: string): ScopeExclusionReason | undefined {
  return classifyScope({ file }).scopeExclusionReason;
}

function configuredPathReason(file: string, config: RepairPlannerInput["config"]): ScopeExclusionReason | undefined {
  return classifyScope({ file }, config).scopeExclusionReason;
}

function unsupported(input: RepairPlannerInput, reason: RepairStrategyReason): RepairPlan {
  return {
    finding: input.finding,
    strategy: "unsupported",
    editableFiles: [],
    verificationTargets: flowFiles(input),
    reason,
  };
}

function isGeneratedFile(file: string): boolean {
  return defaultPathReason(file) === "generated";
}

function sourceOwnerForGenerated(input: RepairPlannerInput): string | undefined {
  const generatedFile = input.file ?? input.finding.file;
  if (input.cwd) {
    const resolved = resolveGeneratedSourceOwner(input.cwd, generatedFile);
    if (resolved?.sourceOwner) return resolved.sourceOwner;
  }
  return flowFiles(input).find((file) => file !== generatedFile && !isGeneratedFile(file));
}

function isGeneratedFinding(input: RepairPlannerInput): boolean {
  const file = input.file ?? input.finding.file;
  if (input.cwd && isGeneratedArtifact(input.cwd, file)) return true;
  return isGeneratedFile(file) || input.scope?.scopeExclusionReason === "generated";
}

function isJscpdDuplicate(input: RepairPlannerInput): boolean {
  return (input.tool ?? input.finding.tool) === "jscpd" && (input.rule ?? input.finding.rule) === "duplicate-code";
}

function isCrossFileDuplicate(input: RepairPlannerInput): boolean {
  return isJscpdDuplicate(input) && flowFiles(input).length > 1;
}

/** Lines in the first clone region (from jscpd's flowPath range). */
function duplicateLineCount(input: RepairPlannerInput): number {
  const fp = input.flowPath ?? input.finding.flowPath;
  if (!fp?.[0]?.range) return 0;
  return fp[0].range.endLine - fp[0].range.startLine + 1;
}

/** True when any file in the clone pair is a test/spec file. */
function involvesTestFile(input: RepairPlannerInput): boolean {
  return flowFiles(input).some(isTestFile);
}

const MIN_DUPLICATE_LINES = 10;

/**
 * Compute a shared module path from the common parent of the clone files.
 * e.g. ["src/a/foo.ts", "src/a/bar.ts"] → "src/a/_shared.ts"
 *      ["src/a/foo.ts", "src/b/bar.ts"] → "src/_shared.ts"
 */
export function computeSharedModulePath(files: string[]): string {
  if (files.length < 2) return files[0] ?? "_shared.ts";
  const dirs = files.map((f) => dirname(f).split("/"));
  const common: string[] = [];
  for (let i = 0; i < dirs[0]!.length; i++) {
    if (dirs.every((d) => d[i] === dirs[0]![i])) common.push(dirs[0]![i]!);
    else break;
  }
  const ext = basename(files[0]!).replace(/^.*(\.[cm]?[jt]sx?)$/, "$1");
  return join(common.length > 0 ? common.join("/") : "src", `_shared${ext}`);
}

function isPackageJsonUnusedDependency(input: RepairPlannerInput): boolean {
  const file = input.file ?? input.finding.file;
  const rule = input.rule ?? input.finding.rule;
  const message = input.finding.message;
  return /(^|\/)package\.json$/.test(file) && (rule === "unused-dependency" || /unused .*dependency/i.test(message));
}

function isUnusedImport(input: RepairPlannerInput): boolean {
  const rule = input.rule ?? input.finding.rule;
  return UNUSED_IMPORT_RE.test(rule) || UNUSED_IMPORT_RE.test(input.finding.message);
}

function isEslintAutofixable(input: RepairPlannerInput): boolean {
  const tool = input.tool ?? input.finding.tool;
  const rule = input.rule ?? input.finding.rule;
  return (
    tool === "sonarjs" &&
    (input.finding.autofixable === true ||
      input.config?.eslintAutofixableRules?.includes(rule) === true ||
      AUTO_FIX_RE.test(input.finding.message) ||
      AUTO_FIX_RE.test(input.finding.remediation ?? ""))
  );
}

function firstExcludedReason(files: string[], config: RepairPlannerInput["config"]): ScopeExclusionReason | undefined {
  for (const file of files) {
    const reason = configuredPathReason(file, config);
    if (reason) return reason;
  }
  return undefined;
}

export function planRepair(input: RepairPlannerInput): RepairPlan {
  const file = input.file ?? input.finding.file;
  const category = input.category ?? input.finding.category;
  const scope = input.scope ?? input.finding;
  const files = flowFiles(input);

  if (category === "secret" || input.finding.track === "report-only") {
    return unsupported(input, "report-only");
  }

  if (isCrossFileDuplicate(input)) {
    if (scope.inScope === false) return unsupported(input, "out-of-scope");
    const excluded = firstExcludedReason(files, input.config);
    if (excluded) return unsupported(input, excluded);
    if (scope.inFixScope === false) return unsupported(input, scope.scopeExclusionReason ?? "out-of-scope");
    if (duplicateLineCount(input) < MIN_DUPLICATE_LINES) return unsupported(input, "report-only");
    if (involvesTestFile(input)) return unsupported(input, "report-only");
    const sharedModule = computeSharedModulePath(files);
    const editableFiles = files.includes(sharedModule) ? files : [...files, sharedModule];
    return {
      finding: input.finding,
      strategy: "multi-file-duplicate-refactor",
      editableFiles,
      verificationTargets: files,
    };
  }

  if (isGeneratedFinding(input)) {
    const owner = sourceOwnerForGenerated(input);
    if (!owner) return unsupported(input, "generated-source-not-found");
    return {
      finding: input.finding,
      strategy: "generated-source-repair",
      editableFiles: [owner],
      verificationTargets: unique([file, owner]),
    };
  }

  if (
    isTestFile(file) &&
    input.config?.includeTests &&
    (scope.scopeExclusionReason === undefined || scope.scopeExclusionReason === "tests")
  ) {
    return {
      finding: input.finding,
      strategy: "test-file-repair",
      editableFiles: [file],
      verificationTargets: [file],
    };
  }

  if (scope.inFixScope === false) {
    return unsupported(input, scope.scopeExclusionReason ?? "out-of-scope");
  }

  if (isPackageJsonUnusedDependency(input)) {
    return {
      finding: input.finding,
      strategy: "deterministic-package-json-cleanup",
      editableFiles: [file],
      verificationTargets: [file],
      reason: "deterministic-not-dispatched",
    };
  }

  if (isUnusedImport(input)) {
    return {
      finding: input.finding,
      strategy: "deterministic-ts-organize-imports",
      editableFiles: [file],
      verificationTargets: [file],
      reason: "deterministic-not-dispatched",
    };
  }

  if (isEslintAutofixable(input)) {
    return {
      finding: input.finding,
      strategy: "deterministic-eslint-fix",
      editableFiles: [file],
      verificationTargets: [file],
      reason: "deterministic-not-dispatched",
    };
  }

  if (category === "dead-code") {
    return {
      finding: input.finding,
      strategy: "dead-code-cleanup",
      editableFiles: [file],
      verificationTargets: [file],
    };
  }

  return {
    finding: input.finding,
    strategy: "single-file-ai-edit",
    editableFiles: [file],
    verificationTargets: [file],
  };
}

export function applyRepairPlanToFinding(plan: RepairPlan): Finding {
  plan.finding.repairStrategy = plan.strategy;
  if (plan.reason) plan.finding.repairStrategyReason = plan.reason;
  else delete plan.finding.repairStrategyReason;
  return plan.finding;
}

export function isAiDispatchStrategy(strategy: RepairStrategy): boolean {
  return (
    strategy === "single-file-ai-edit" ||
    strategy === "multi-file-duplicate-refactor" ||
    strategy === "generated-source-repair" ||
    strategy === "test-file-repair" ||
    strategy === "dead-code-cleanup"
  );
}
