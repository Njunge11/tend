import type { Finding } from "../findings/finding.js";

/**
 * Single source of truth for every model tend runs. No other module names a model:
 * the config default, special-case escalation, and the session spawn all resolve
 * through the constants and {@link modelForUnit} here.
 *
 * Both constants are full model+version ids, pinned deliberately so a run's model
 * is explicit in config, output, and reports. When a new model generation ships,
 * bump them HERE and nowhere else.
 */

/** Model for ordinary fixes when none is configured. */
export const DEFAULT_MODEL = "claude-sonnet-4-6";

/**
 * The more capable model for fixes that restructure code rather than tweak it.
 * Cross-file duplication means reasoning about several call sites at once and
 * extracting a shared abstraction; cognitive-complexity findings demand a
 * whole-function rewrite that preserves behavior. Some Knip dead-code findings
 * also require repo wiring/reachability reasoning before deleting or unexporting
 * code. These are harder than the single-file, localized edits the default model
 * handles well — Opus is worth the cost (the default model repeatedly timed out
 * on a complexity-67 refactor in a real run).
 */
export const CAPABLE_MODEL = "claude-opus-4-8";

/** Complexity refactors are detected by rule — their category ("smell") is too broad. */
const COMPLEXITY_RULE = "sonarjs/cognitive-complexity";
const HIGH_RISK_KNIP_RULES = new Set(["unused-file", "unused-export", "unused-type"]);
const WIRING_PATH_RE = /(^|\/)(api|auth|authz|clients?|db|init|root|route|router|server|trpc)(\.|\/|-)/i;

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

function isHighRiskKnipDeadCode(finding: Pick<Finding, "tool" | "rule" | "file">): boolean {
  if (finding.tool !== "knip" || !HIGH_RISK_KNIP_RULES.has(finding.rule)) return false;
  return finding.rule === "unused-file" || WIRING_PATH_RE.test(finding.file);
}

/**
 * Pick the `claude -p` model for one work unit (one file's findings). A unit that
 * contains any duplication finding gets the capable model (configurable via
 * `duplicationModel`), as does one containing any cognitive-complexity finding
 * (configurable via `complexityModel`); both default to {@link CAPABLE_MODEL}.
 * High-risk Knip dead-code cleanup also uses the capable model because safe
 * deletion often depends on framework wiring and indirect reachability. Everything
 * else — and any empty unit — gets the configured default model. Findings share a
 * single session per unit, so ONE capable-tier finding lifts the whole unit/batch
 * to the capable model. When a unit contains multiple capable kinds, the
 * duplication override wins, then the complexity override.
 */
export function modelForUnit(
  findings: Pick<Finding, "category" | "file" | "rule" | "tool">[],
  config: ModelSelectionConfig,
): string {
  if (findings.some(isDuplication)) {
    return config.duplicationModel ?? CAPABLE_MODEL;
  }
  if (findings.some(isComplexityRefactor)) {
    return config.complexityModel ?? CAPABLE_MODEL;
  }
  if (findings.some(isHighRiskKnipDeadCode)) {
    return CAPABLE_MODEL;
  }
  return config.model;
}

/**
 * Every model this run's config can route a unit to: the default plus the
 * capable-tier models for duplication and complexity escalation, deduped.
 * The startup preflight pings each of these so a typo'd model fails the run
 * in seconds instead of after a full scan-and-fix pass of dead sessions.
 */
export function distinctRunModels(config: ModelSelectionConfig): string[] {
  return [
    ...new Set([
      config.model,
      config.duplicationModel ?? CAPABLE_MODEL,
      config.complexityModel ?? CAPABLE_MODEL,
    ]),
  ];
}
