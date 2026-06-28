import { createHash } from "node:crypto";
import { z } from "zod";
import { REPAIR_STRATEGIES } from "../fixing/repair-strategy.js";
import type { FailureClass } from "../session/types.js";

export const TOOLS = ["sonarjs", "knip", "jscpd", "semgrep", "osv", "gitleaks"] as const;
export const SCOPE_EXCLUSION_REASONS = ["generated", "fixtures", "tests", "out-of-scope"] as const;
const FAILURE_CLASSES = [
  "tool-timeout",
  "rate-limit",
  "model-tool-failure",
  "model-rejected",
  "sandbox-setup-failed",
  "patch-conflict",
  "unowned-patch",
  "final-integration-failed",
  "no-edit",
  "no-op",
  "regression",
  "unresolved-target",
  "typecheck",
  "broke-test",
  "suppression",
  "needs-lockfile-update",
] as const satisfies readonly FailureClass[];

const RangeSchema = z.object({
  startLine: z.number(),
  startCol: z.number(),
  endLine: z.number(),
  endCol: z.number(),
});

export const FindingSchema = z.object({
  id: z.string(),
  retryId: z.string().optional(),
  tool: z.enum(TOOLS),
  rule: z.string(),
  category: z.enum([
    "bug",
    "smell",
    "dead-code",
    "duplication",
    "security",
    "secret",
    "vuln-dep",
  ]),
  severity: z.enum(["error", "warning", "info"]),
  file: z.string(),
  range: RangeSchema,
  message: z.string(),
  helpUri: z.string().optional(),
  flowPath: z
    .array(z.object({ file: z.string(), line: z.number(), range: RangeSchema.optional() }))
    .optional(),
  remediation: z.string().optional(),
  autofixable: z.boolean().optional(),
  repairStrategy: z.enum(REPAIR_STRATEGIES).optional(),
  repairStrategyReason: z.string().optional(),
  track: z.enum(["ai-fix", "deterministic", "report-only"]),
  status: z.enum(["pending", "fixing", "fixed", "reverted", "unfixable", "skipped"]),
  attempts: z.number(),
  revertReason: z
    .enum([
      "broke-test",
      "suppression",
      "regression",
      "unresolved-target",
      "typecheck",
      "session-error",
      "needs-lockfile-update",
      "sandbox-setup-failed",
      "patch-conflict",
      "unowned-patch",
      "final-integration-failed",
    ])
    .optional(),
  revertDetail: z.string().optional(),
  finalFailureClass: z.enum(FAILURE_CLASSES).optional(),
  firstSeenLoop: z.number(),
  lastSeenLoop: z.number(),
  // Whether this finding is in the developer's fix scope (changed files). Absent means
  // not yet scoped → treated as in-scope. The summary uses it to split "your changes"
  // from "repo-wide (outside your changes)".
  inScope: z.boolean().optional(),
  // Report scope is the broad scanner-visible set. Fix scope is narrower: Tend reports
  // generated/cache/fixture/tooling findings, but does not spend AI sessions there by default.
  inReportScope: z.boolean().default(true),
  inFixScope: z.boolean().default(true),
  scopeExclusionReason: z.enum(SCOPE_EXCLUSION_REASONS).optional(),
});

export type Finding = z.infer<typeof FindingSchema>;
export type Tool = (typeof TOOLS)[number];
export type Track = Finding["track"];
export type ScopeExclusionReason = (typeof SCOPE_EXCLUSION_REASONS)[number];

/** The components that give a finding its stable identity. */
type FingerprintInput = {
  tool: string;
  rule: string;
  file: string;
  line: number;
  message: string;
};

function normalizeMessage(message: string): string {
  return message
    .replace(/:\d+(-\d+)?/g, ":_")
    .replace(/\b(line|col(?:umn)?)\s+\d+/gi, "$1 _");
}

/**
 * Stable identity for a finding. Uses a 5-line bucket instead of the exact line
 * so small position shifts (from edits above) don't change the fingerprint. The
 * message is normalized to strip line:col references that drift between scans.
 */
export function fingerprint(input: FingerprintInput): string {
  const lineBucket = Math.floor(input.line / 5);
  const key = [input.tool, input.rule, input.file, lineBucket, normalizeMessage(input.message)].join("|");
  return createHash("sha256").update(key).digest("hex");
}

/**
 * The fingerprint components minus the line bucket. When an accepted edit shifts a finding
 * across a 5-line bucket boundary its fingerprint changes; this looser identity lets
 * reconcile re-match the drifted finding to its known record instead of inventing a phantom
 * "fixed" plus a ghost "new" finding.
 */
export function normalizedIdentity(
  f: Pick<Finding, "tool" | "rule" | "file" | "message">,
): string {
  return [f.tool, f.rule, f.file, normalizeMessage(f.message)].join("|");
}
