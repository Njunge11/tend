import type { OutputEnv } from "./env.js";
import type { TendEvent } from "./events.js";
import { LiveReporter } from "./live-reporter.js";
import { PlainReporter } from "./plain-reporter.js";
import type { Theme } from "./theme.js";

/**
 * Renders a run to the terminal. Two implementations: a live, redrawing view for TTYs and a
 * plain one-line-per-event view for pipes/CI. Both consume the same EventBus stream.
 */
export interface Reporter {
  /** Paint the wordmark synchronously (must be fast — the screen should never look dead). */
  start(): void;
  /** Write a dim context line under the header (snapshot note, detected stack, hints). */
  note(line: string): void;
  /** Feed one orchestrator event. */
  onEvent(event: TendEvent): void;
  /** Resolves when the live view has finished drawing (immediately for the plain view). */
  run(): Promise<void>;
  /** Force the view to wind down even if no `done` event arrived (e.g. the run threw). */
  close(): void;
}

export type ReporterDeps = { env: OutputEnv; theme: Theme; write: (line: string) => void };

/** Pick the reporter that fits the environment. */
export function createReporter(deps: ReporterDeps): Reporter {
  return deps.env.interactive ? new LiveReporter(deps) : new PlainReporter(deps);
}
