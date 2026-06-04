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

const ZERO_AI_USAGE = {
  estimatedCostUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  sessions: 0,
};

export const ReportSchema = z.object({
  findings: z.array(FindingSchema),
  secrets: z.array(FindingSchema),
  depBumps: z.array(DepBumpSchema),
  flaggedBehaviorChanges: z.array(BehaviorChangeSchema),
  scannerStatuses: z.array(ScannerStatusSchema).default([]),
  // Default to zero so reports written before usage tracking still parse.
  aiUsage: AiUsageSchema.default(ZERO_AI_USAGE),
  loops: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  exitStatus: z.number().int(),
});

export type Report = z.infer<typeof ReportSchema>;
export type BehaviorChange = z.infer<typeof BehaviorChangeSchema>;
export type ScannerStatus = z.infer<typeof ScannerStatusSchema>;
export type AiUsage = z.infer<typeof AiUsageSchema>;
