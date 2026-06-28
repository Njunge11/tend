import { EFFORT_LEVELS, type Effort } from "../config/config.js";
import type { Finding } from "../findings/finding.js";

/**
 * The per-finding reasoning effort: mechanical units (all dead-code / autofixable) only need the
 * cheapest tier; anything that requires real reasoning gets "medium". An empty unit defaults to
 * "medium" so a misconfigured/empty batch isn't silently under-powered.
 */
export function effortForFindings(findings: Pick<Finding, "category" | "autofixable">[]): Effort {
  if (findings.length === 0) return "medium";
  const allMechanical = findings.every((f) => f.category === "dead-code" || f.autofixable === true);
  return allMechanical ? "low" : "medium";
}

/** The lower of two efforts by EFFORT_LEVELS order (low < medium < high < xhigh < max). */
export function minEffort(a: Effort, b: Effort): Effort {
  return EFFORT_LEVELS.indexOf(a) <= EFFORT_LEVELS.indexOf(b) ? a : b;
}

/**
 * The effort for one work unit. A configured `--effort` is a CEILING, not an override: a mechanical
 * unit still runs at its cheaper per-finding effort even when the user sets a high `--effort`, but
 * no unit exceeds the configured cap. Unset → the per-finding effort.
 */
export function effortForUnit(
  findings: Pick<Finding, "category" | "autofixable">[],
  configEffort?: Effort,
): Effort {
  const perFinding = effortForFindings(findings);
  return configEffort ? minEffort(configEffort, perFinding) : perFinding;
}
