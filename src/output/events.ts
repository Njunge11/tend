import type { Tool } from "../findings/finding.js";
import type { FixStage } from "../fixing/progress.js";
import type { ScannerStatusKind } from "../scanners/scanner.js";

/** What happened to a file in the current dispatched batch. "left" = not attempted. */
export type FileOutcome = "fixed" | "reverted" | "left";

/** Per-reason counts of in-scope findings the fix policy excludes from dispatch. */
export type AuditExclusions = {
  tests: number;
  generated: number;
  fixtures: number;
  outOfScope: number;
  reportOnly: number;
};

export type TendEvent =
  | { type: "snapshot" }
  | { type: "detected"; packageManager: string; typescript: boolean; testRunner?: string }
  | { type: "scan-start"; loop: number }
  | { type: "scanner-start"; loop: number; tool: Tool }
  | {
      type: "scanner-result";
      loop: number;
      tool: Tool;
      status: ScannerStatusKind;
      findings: number;
      reason?: string;
    }
  // `scanned` = resolved fix-scope file count when known; `findings`/`files` = in-scope findings.
  // `eligible` = the subset of those findings the fix policy will actually dispatch; `excluded`
  // accounts for the rest, so findings = eligible + sum(excluded) when both are present.
  | {
      type: "audit";
      loop: number;
      findings: number;
      files: number;
      scanned?: number;
      eligible?: number;
      excluded?: AuditExclusions;
    }
  // Announces the batch about to be fixed this loop. `findings` = total findings across the
  // dispatched units (the stable live-view denominator; jobs split, findings don't).
  | { type: "loop-start"; loop: number; files: string[]; concurrency: number; findings: number }
  // `model` = the model string passed to `claude -p` for this job, or "deterministic".
  | { type: "file-start"; loop: number; file: string; rule?: string; model?: string }
  | { type: "file-stage"; loop: number; file: string; stage: FixStage; detail?: string }
  // `findings` = how many findings this job covered (0 for a split-parent placeholder).
  | { type: "file-result"; loop: number; file: string; outcome: FileOutcome; findings: number; reason?: string; detail?: string }
  | { type: "loop-complete"; loop: number; fixed: number; reverted: number; remaining: number; estimatedCostUsd: number }
  | { type: "done"; exitStatus: number }
  // Dev-only structured decision/diagnostic record. Carries the orchestrator's internal verdicts
  // (why a finding went terminal vs retried, which tools were skipped, why a batch split, what a
  // deterministic unit did, model preflight). The live reporters ignore it; the tracer records it
  // to events.jsonl (chronological) and decisions.jsonl (filterable) so a real run is auditable.
  | { type: "debug"; loop?: number; action: string; detail?: string; data?: Record<string, unknown> };

type Listener = (event: TendEvent) => void;

/** Minimal synchronous event bus. With no listener, emit is a no-op (silent mode). */
export class EventBus {
  private readonly listeners: Listener[] = [];

  on(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  emit(event: TendEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
