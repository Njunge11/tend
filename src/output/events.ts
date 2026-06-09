import type { Tool } from "../findings/finding.js";
import type { FixStage } from "../fixing/progress.js";
import type { ScannerStatusKind } from "../scanners/scanner.js";

/** What happened to a file in the current dispatched batch. "left" = not attempted. */
export type FileOutcome = "fixed" | "reverted" | "left";

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
  | { type: "audit"; loop: number; findings: number; files: number; scanned?: number }
  // Announces the batch about to be fixed this loop. `findings` = total findings across the
  // dispatched units (the stable live-view denominator; jobs split, findings don't).
  | { type: "loop-start"; loop: number; files: string[]; concurrency: number; findings: number }
  // `model` = the model string passed to `claude -p` for this job, or "deterministic".
  | { type: "file-start"; loop: number; file: string; rule?: string; model?: string }
  | { type: "file-stage"; loop: number; file: string; stage: FixStage; detail?: string }
  // `findings` = how many findings this job covered (0 for a split-parent placeholder).
  | { type: "file-result"; loop: number; file: string; outcome: FileOutcome; findings: number; reason?: string; detail?: string }
  | { type: "loop-complete"; loop: number; fixed: number; reverted: number; remaining: number; estimatedCostUsd: number }
  | { type: "done"; exitStatus: number };

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
