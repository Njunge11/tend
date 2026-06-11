import type { ReporterDeps } from "./reporter.js";
import type { Theme } from "./theme.js";

export abstract class BaseReporter {
  protected readonly theme: Theme;
  protected readonly write: (line: string) => void;

  // Takes full ReporterDeps (not just what this base uses) so subclasses that need nothing
  // beyond theme/write can omit their constructor entirely without narrowing what callers
  // may pass (no-useless-constructor's fix would otherwise change the public signature).
  constructor(deps: ReporterDeps) {
    this.theme = deps.theme;
    this.write = deps.write;
  }

  start(): void {
    this.write(this.theme.wordmark());
  }

  note(line: string): void {
    this.write(this.theme.dim(line));
  }
}
