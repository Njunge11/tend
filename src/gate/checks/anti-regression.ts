import type { Finding } from "../../findings/finding.js";
import { pass, reject, type CheckResult } from "../check.js";

export type AntiRegressionOptions = {
  /** Also reject findings from the original target set that remain after the fix. */
  requireResolved?: boolean;
  /**
   * Findings already present before the fix, scanned with the same scope as `after`. When
   * provided, only findings absent from this set count as "introduced". Without it, a
   * cross-file scanner (e.g. jscpd, which detects clones repo-wide) reports pre-existing
   * duplicates that merely live in the verification scope, and they get misread as
   * regressions — reverting good fixes and stalling the loop. Defaults to the target
   * findings (`before`) for backward compatibility.
   */
  baselineIds?: ReadonlySet<string>;
};

/**
 * Reject if the fix introduced any finding that wasn't present before — no lateral
 * moves. A fix must strictly reduce findings; trading one issue for another is what
 * would let the loop oscillate instead of converge.
 */
export function antiRegression(
  before: Finding[],
  after: Finding[],
  opts: AntiRegressionOptions = {},
): CheckResult {
  const knownIds = new Set(before.map((f) => f.id));

  if (opts.requireResolved) {
    const unresolved = after.filter((f) => knownIds.has(f.id));
    if (unresolved.length > 0) {
      const detail = unresolved.map((f) => `${f.file}:${f.range.startLine} ${f.rule}`).join(", ");
      return reject("regression", `Fix did not clear target finding(s): ${detail}`);
    }
  }

  // "Introduced" = present after the fix but not before. The baseline is the pre-fix scan of
  // the same scope when supplied; otherwise the target findings (legacy behavior).
  const baseline = opts.baselineIds ?? knownIds;
  const introduced = after.filter((f) => !baseline.has(f.id));

  if (introduced.length > 0) {
    const detail = introduced.map((f) => `${f.file}:${f.range.startLine} ${f.rule}`).join(", ");
    return reject("regression", `Fix introduced new finding(s): ${detail}`);
  }

  return pass();
}
