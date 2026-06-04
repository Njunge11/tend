/** What happened to a file's fix attempt. "left" = in scope but never dispatched. */
export type FileOutcome = "fixed" | "reverted" | "left";

export type TendEvent =
  | { type: "snapshot" }
  | { type: "detected"; packageManager: string; typescript: boolean; testRunner?: string }
  | { type: "scan-start"; loop: number }
  // `scanned` = resolved fix-scope file count when known; `findings`/`files` = in-scope findings.
  | { type: "audit"; loop: number; findings: number; files: number; scanned?: number }
  // Announces the batch about to be fixed this loop, so the live view can show queued work.
  | { type: "loop-start"; loop: number; files: string[]; concurrency: number }
  | { type: "file-start"; loop: number; file: string; rule?: string }
  | { type: "file-result"; loop: number; file: string; outcome: FileOutcome; reason?: string }
  | { type: "loop-complete"; loop: number; fixed: number }
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
