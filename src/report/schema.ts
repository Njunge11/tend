import { z } from "zod";
import { FindingSchema, TOOLS } from "../findings/finding.js";

export const DepBumpSchema = z.object({
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

export const ReportSchema = z.object({
  findings: z.array(FindingSchema),
  secrets: z.array(FindingSchema),
  depBumps: z.array(DepBumpSchema),
  flaggedBehaviorChanges: z.array(BehaviorChangeSchema),
  scannerStatuses: z.array(ScannerStatusSchema).default([]),
  loops: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  exitStatus: z.number().int(),
});

export type Report = z.infer<typeof ReportSchema>;
export type DepBump = z.infer<typeof DepBumpSchema>;
export type BehaviorChange = z.infer<typeof BehaviorChangeSchema>;
export type ScannerStatus = z.infer<typeof ScannerStatusSchema>;
