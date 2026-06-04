import type { Theme } from "./theme.js";

export abstract class BaseReporter {
  protected readonly theme: Theme;
  protected readonly write: (line: string) => void;

  constructor(deps: { theme: Theme; write: (line: string) => void }) {
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
