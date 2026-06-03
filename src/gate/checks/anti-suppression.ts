import { pass, reject, type CheckResult } from "../check.js";

const SUPPRESSION_PATTERNS: { re: RegExp; what: string }[] = [
  { re: /eslint-disable/, what: "eslint-disable" },
  { re: /@ts-ignore/, what: "@ts-ignore" },
  { re: /@ts-nocheck/, what: "@ts-nocheck" },
  { re: /\bas\s+any\b/, what: "cast to any" },
  { re: /:\s*any\b/, what: "any type annotation" },
  { re: /<any>/, what: "cast to any" },
];

type DiffLines = { added: string[]; removed: string[] };

function splitDiff(diff: string): DiffLines {
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue; // file headers
    if (line.startsWith("+")) added.push(line.slice(1));
    else if (line.startsWith("-")) removed.push(line.slice(1));
  }
  return { added, removed };
}

const nonBlank = (lines: string[]) => lines.filter((l) => l.trim().length > 0);

/**
 * Reject a change-set that cheats the scanner rather than fixing the code:
 * newly-added suppression comments / any-casts, or code deleted instead of fixed.
 * Only NEW (added) lines are inspected — pre-existing suppressions in context are ignored.
 */
export function antiSuppression(diff: string): CheckResult {
  const { added, removed } = splitDiff(diff);

  for (const line of added) {
    for (const { re, what } of SUPPRESSION_PATTERNS) {
      if (re.test(line)) return reject("suppression", `Fix added ${what}`);
    }
  }

  if (nonBlank(removed).length > 0 && nonBlank(added).length === 0) {
    return reject("suppression", "Code was deleted instead of fixed");
  }

  return pass();
}
