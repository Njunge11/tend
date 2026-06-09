import type { Finding } from "../findings/finding.js";

/**
 * The more capable model used for duplication refactors. Removing cross-file
 * duplication means reasoning about several call sites at once and extracting a
 * shared abstraction without changing behavior — harder than the single-file,
 * localized edits the default model handles well. Opus is worth the cost here.
 */
export const DUPLICATION_MODEL = "claude-opus-4-6";

/** Config slice that picks the fix model; an explicit `duplicationModel` overrides the default. */
type ModelSelectionConfig = { model: string; duplicationModel?: string };

function needsCapableModel(finding: Pick<Finding, "category">): boolean {
  return finding.category === "duplication";
}

/**
 * Pick the `claude -p` model for one work unit (one file's findings). A unit that
 * contains any duplication finding gets the capable model (configurable via
 * `duplicationModel`, default {@link DUPLICATION_MODEL}); everything else — and any
 * empty unit — gets the configured default model. Findings share a single session
 * per unit, so one duplication finding lifts the whole unit to the capable model.
 */
export function modelForUnit(
  findings: Pick<Finding, "category">[],
  config: ModelSelectionConfig,
): string {
  if (findings.some(needsCapableModel)) {
    return config.duplicationModel ?? DUPLICATION_MODEL;
  }
  return config.model;
}
