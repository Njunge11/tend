export type TerminationSignal = "SIGINT" | "SIGTERM";

const SIGNALS: TerminationSignal[] = ["SIGINT", "SIGTERM"];

/**
 * Run `handler` once when the process is asked to terminate (Ctrl-C / SIGTERM), so a run can
 * tear down its sandboxes before exiting instead of leaking worktrees. Each signal fires the
 * handler at most once (the run then exits). Returns an unregister function for the normal
 * completion path. The emitter is injectable so tests don't have to raise real signals.
 */
export function onTerminationSignals(
  handler: (signal: TerminationSignal) => void,
  emitter: NodeJS.EventEmitter = process,
): () => void {
  const wrappers = new Map<TerminationSignal, () => void>();
  for (const signal of SIGNALS) {
    const wrapper = (): void => handler(signal);
    emitter.once(signal, wrapper);
    wrappers.set(signal, wrapper);
  }
  return () => {
    for (const [signal, wrapper] of wrappers) emitter.removeListener(signal, wrapper);
  };
}
