import type { Finding } from "../findings/finding.js";

/**
 * The more capable model for fixes that restructure code rather than tweak it.
 * Cross-file duplication means reasoning about several call sites at once and
 * extracting a shared abstraction; cognitive-complexity findings demand a
 * whole-function rewrite that preserves behavior. Both are harder than the
 * single-file, localized edits the default model handles well — Opus is worth
 * the cost (the default model repeatedly timed out on a complexity-67 refactor
 * in a real run).
 */
export const CAPABLE_MODEL = "claude-opus-4-8";

/** Complexity refactors are detected by rule — their category ("smell") is too broad. */
const COMPLEXITY_RULE = "sonarjs/cognitive-complexity";

/**
 * Config slice that picks the fix model; `duplicationModel` / `complexityModel`
 * override the capable default for their respective finding kinds.
 */
type ModelSelectionConfig = {
  model: string;
  duplicationModel?: string;
  complexityModel?: string;
};

function isDuplication(finding: Pick<Finding, "category">): boolean {
  return finding.category === "duplication";
}

function isComplexityRefactor(finding: Pick<Finding, "rule">): boolean {
  return finding.rule === COMPLEXITY_RULE;
}

/**
 * Pick the `claude -p` model for one work unit (one file's findings). A unit that
 * contains any duplication finding gets the capable model (configurable via
 * `duplicationModel`), as does one containing any cognitive-complexity finding
 * (configurable via `complexityModel`); both default to {@link CAPABLE_MODEL}.
 * Everything else — and any empty unit — gets the configured default model.
 * Findings share a single session per unit, so ONE duplication or complexity
 * finding lifts the whole unit/batch to the capable model. When a unit contains
 * both kinds, the duplication override wins.
 */
export function modelForUnit(
  findings: Pick<Finding, "category" | "rule">[],
  config: ModelSelectionConfig,
): string {
  if (findings.some(isDuplication)) {
    return config.duplicationModel ?? CAPABLE_MODEL;
  }
  if (findings.some(isComplexityRefactor)) {
    return config.complexityModel ?? CAPABLE_MODEL;
  }
  return config.model;
}
