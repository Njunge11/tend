import { z } from "zod";
import { FindingSchema, TOOLS } from "../findings/finding.js";

const DepBumpSchema = z.object({
  findingId: z.string(),
  remediation: z.string(),
});

/** Per-scanner outcome for a run: did it run clean, get skipped, or fail (with a reason). */
export const ScannerStatusSchema = z.object({
  tool: z.enum(TOOLS),
  status: z.enum(["ran", "skipped", "failed"]),
  reason: z.string().optional(),
});

export const BehaviorChangeSchema = z.object({
  findingId: z.string(),
  file: z.string(),
  note: z.string(),
});

/**
 * Estimated AI cost/usage for a run. `estimatedCostUsd` is Claude's client-side
 * `total_cost_usd` estimate — never authoritative billing.
 */
export const AiUsageSchema = z.object({
  estimatedCostUsd: z.number().nonnegative(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheCreationInputTokens: z.number().nonnegative(),
  cacheReadInputTokens: z.number().nonnegative(),
  sessions: z.number().int().nonnegative(),
});

export const RunScopeSchema = z
  .object({
    type: z.enum(["all", "scoped"]),
    fileCount: z.number().int().nonnegative().optional(),
  })
  .default({ type: "scoped" });

export const FixPolicySchema = z
  .object({
    includeTests: z.boolean().default(false),
    include: z.array(z.string()).default([]),
    exclude: z.array(z.string()).default([]),
    includeGenerated: z.boolean().default(false),
    includeFixtures: z.boolean().default(false),
  })
  .default({
    includeTests: false,
    include: [],
    exclude: [],
    includeGenerated: false,
    includeFixtures: false,
  });

export const FailureSummarySchema = z.object({
  blockingSecrets: z.number().int().nonnegative(),
  unresolvedEligible: z.number().int().nonnegative(),
  toolFailures: z.number().int().nonnegative(),
  failedDeterministic: z.number().int().nonnegative(),
  sessionErrors: z.number().int().nonnegative(),
  regressions: z.number().int().nonnegative(),
  typecheckFailures: z.number().int().nonnegative(),
  testFailures: z.number().int().nonnegative(),
  sandboxSetupFailures: z.number().int().nonnegative().default(0),
  patchConflicts: z.number().int().nonnegative().default(0),
  unownedPatches: z.number().int().nonnegative().default(0),
  finalIntegrationFailures: z.number().int().nonnegative().default(0),
});

/** Identity of a new finding surfaced by the post-run rescan: tool / rule / file / line. */
export const FinalIntegrationFindingSchema = z.object({
  tool: z.enum(TOOLS),
  rule: z.string(),
  file: z.string(),
  line: z.number().int().nonnegative(),
});

export const FinalIntegrationSchema = z.object({
  ok: z.boolean(),
  files: z.array(z.string()).default([]),
  detail: z.string().optional(),
  // New scanner findings the post-run rescan surfaced and the repair budget couldn't clear.
  // Reported (by identity) alongside the kept fixes — a new finding is never a reason to revert.
  findings: z.array(FinalIntegrationFindingSchema).default([]),
});

/** Why the scan → fix → re-audit loop stopped. Single source of truth for the orchestrator. */
const TERMINATIONS = [
  "converged",
  "max-loops",
  "no-progress",
  "no-scanners",
  "retryable-infrastructure",
] as const;

export const TerminationSchema = z.enum(TERMINATIONS);

const ZERO_AI_USAGE = {
  estimatedCostUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  sessions: 0,
};

const ZERO_FAILURE_SUMMARY = {
  blockingSecrets: 0,
  unresolvedEligible: 0,
  toolFailures: 0,
  failedDeterministic: 0,
  sessionErrors: 0,
  regressions: 0,
  typecheckFailures: 0,
  testFailures: 0,
  sandboxSetupFailures: 0,
  patchConflicts: 0,
  unownedPatches: 0,
  finalIntegrationFailures: 0,
};

export const ReportSchema = z.object({
  findings: z.array(FindingSchema),
  secrets: z.array(FindingSchema),
  reportOnly: z.array(FindingSchema).default([]),
  depBumps: z.array(DepBumpSchema),
  flaggedBehaviorChanges: z.array(BehaviorChangeSchema),
  scannerStatuses: z.array(ScannerStatusSchema).default([]),
  // Defaults keep older report.json files rendering as the historical changed-files scope.
  runScope: RunScopeSchema,
  fixPolicy: FixPolicySchema,
  // Default to zero so reports written before usage tracking still parse.
  aiUsage: AiUsageSchema.default(ZERO_AI_USAGE),
  failureSummary: FailureSummarySchema.default(ZERO_FAILURE_SUMMARY),
  finalIntegration: FinalIntegrationSchema.optional(),
  unresolvedEligibleCount: z.number().int().nonnegative().default(0),
  loops: z.number().int().nonnegative(),
  // Optional so reports written before termination tracking still parse.
  termination: TerminationSchema.optional(),
  durationMs: z.number().nonnegative(),
  exitStatus: z.number().int(),
});

export type Report = z.infer<typeof ReportSchema>;
export type Termination = z.infer<typeof TerminationSchema>;
export type BehaviorChange = z.infer<typeof BehaviorChangeSchema>;
export type ScannerStatus = z.infer<typeof ScannerStatusSchema>;
export type AiUsage = z.infer<typeof AiUsageSchema>;
export type RunScope = z.infer<typeof RunScopeSchema>;
export type FixPolicy = z.infer<typeof FixPolicySchema>;
export type FailureSummary = z.infer<typeof FailureSummarySchema>;
export type FinalIntegration = z.infer<typeof FinalIntegrationSchema>;
