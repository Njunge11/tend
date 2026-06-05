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
});

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
  unresolvedEligibleCount: z.number().int().nonnegative().default(0),
  loops: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  exitStatus: z.number().int(),
});

export type Report = z.infer<typeof ReportSchema>;
export type BehaviorChange = z.infer<typeof BehaviorChangeSchema>;
export type ScannerStatus = z.infer<typeof ScannerStatusSchema>;
export type AiUsage = z.infer<typeof AiUsageSchema>;
export type RunScope = z.infer<typeof RunScopeSchema>;
export type FixPolicy = z.infer<typeof FixPolicySchema>;
export type FailureSummary = z.infer<typeof FailureSummarySchema>;
