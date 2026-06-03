import type { TendEvent } from "./events.js";
import { reasonLabel } from "./format.js";
import type { Reporter, ReporterDeps } from "./reporter.js";
import type { Theme } from "./theme.js";

/**
 * The non-TTY / CI / piped / `--plain` view: one line per meaningful event, no spinners, no
 * redraw, no color (the theme is already colorless in this mode). Deterministic and easy to
 * grep or pipe into another tool. The final summary is rendered separately by the caller.
 */
export class PlainReporter implements Reporter {
  private readonly theme: Theme;
  private readonly write: (line: string) => void;

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

  onEvent(event: TendEvent): void {
    const { glyph } = this.theme;
    switch (event.type) {
      case "scan-start":
        this.write("scanning…");
        break;
      case "audit": {
        const scanned = event.scanned != null ? `${event.scanned} files ${glyph.bullet} ` : "";
        this.write(`${glyph.scanned} scanned ${scanned}${event.findings} findings ${glyph.bullet} ${event.files} files`);
        break;
      }
      case "loop-start":
        this.write(`fixing loop ${event.loop} ${glyph.bullet} ${event.files.length} files ${glyph.bullet} ${event.concurrency} concurrent`);
        break;
      case "file-result":
        if (event.outcome === "fixed") this.write(`${glyph.fixed} fixed ${event.file}`);
        else if (event.outcome === "reverted") this.write(`${glyph.reverted} reverted ${event.file} — ${reasonLabel(event.reason)}`);
        else this.write(`${glyph.left} left ${event.file}`);
        break;
      // file-start is folded into file-result; snapshot/detected arrive as start() notes;
      // loop-complete/done are covered by the final summary.
      case "snapshot":
      case "detected":
      case "file-start":
      case "loop-complete":
      case "done":
        break;
    }
  }

  run(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {
    // Nothing to wind down — output is synchronous.
  }
}
