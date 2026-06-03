import type { Finding } from "../../findings/finding.js";
import { pass, reject, type CheckResult } from "../check.js";

/**
 * Reject if the fix introduced any finding that wasn't present before — no lateral
 * moves. A fix must strictly reduce findings; trading one issue for another is what
 * would let the loop oscillate instead of converge.
 */
export function antiRegression(before: Finding[], after: Finding[]): CheckResult {
  const knownIds = new Set(before.map((f) => f.id));
  const introduced = after.filter((f) => !knownIds.has(f.id));

  if (introduced.length > 0) {
    const detail = introduced.map((f) => `${f.file}:${f.range.startLine} ${f.rule}`).join(", ");
    return reject("regression", `Fix introduced new finding(s): ${detail}`);
  }

  return pass();
}
