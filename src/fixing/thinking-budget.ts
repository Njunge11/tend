import type { Finding } from "../findings/finding.js";

/** Thinking disabled — mechanical fixes don't need reasoning tokens. */
const THINKING_OFF = 0;

/**
 * Upper bound on extended-thinking tokens per fix session. Unbounded thinking
 * measured ~7000 tokens per finding regardless of difficulty; capping it keeps
 * reasoning fixes correct (gate stays green) at a fraction of the latency.
 */
export const THINKING_BUDGET_CAP = 4096;

/** Config slice that can pin the budget; an explicit value (including 0) always wins. */
type ThinkingBudgetConfig = { thinkingBudget?: number };

function isMechanical(finding: Pick<Finding, "category" | "autofixable">): boolean {
  return finding.category === "dead-code" || finding.autofixable === true;
}

/**
 * Decide the extended-thinking token budget for one finding's fix session.
 * Mechanical findings (dead-code removal, autofixable rules) get thinking off;
 * everything else — reasoning findings and any unrecognized category — gets the
 * bounded cap (the safe default: never spend more than the cap, never starve a
 * finding that might need reasoning). A configured `thinkingBudget` overrides
 * the policy outright, with 0 meaning thinking off.
 */
export function thinkingBudgetFor(
  finding: Pick<Finding, "category" | "autofixable">,
  config?: ThinkingBudgetConfig,
): number {
  if (config?.thinkingBudget !== undefined) return config.thinkingBudget;
  return isMechanical(finding) ? THINKING_OFF : THINKING_BUDGET_CAP;
}

/**
 * Budget for a whole work unit (one file's findings). Takes the most-conservative
 * (largest) per-finding budget so a reasoning finding is never starved of thinking
 * just because it shares the file with a mechanical one. An empty unit and any
 * unrecognized category fall back to the cap. A configured budget overrides all.
 */
export function thinkingBudgetForUnit(
  findings: Pick<Finding, "category" | "autofixable">[],
  config?: ThinkingBudgetConfig,
): number {
  if (config?.thinkingBudget !== undefined) return config.thinkingBudget;
  if (findings.length === 0) return THINKING_BUDGET_CAP;
  return Math.max(...findings.map((finding) => thinkingBudgetFor(finding)));
}

/**
 * Delivery to the `claude -p` session boundary: the env overlay that pins the
 * session's extended-thinking budget. Spread onto the child process env.
 */
export function thinkingEnv(
  findings: Pick<Finding, "category" | "autofixable">[],
  config?: ThinkingBudgetConfig,
): { MAX_THINKING_TOKENS: string } {
  return { MAX_THINKING_TOKENS: String(thinkingBudgetForUnit(findings, config)) };
}
