import { BaseReporter } from "./base-reporter.js";
import type { TendEvent } from "./events.js";
import { reasonLabel } from "./format.js";
import { fixStageLabel } from "../fixing/progress.js";
import type { Reporter, ReporterDeps } from "./reporter.js";

/**
 * The non-TTY / CI / piped / `--plain` view: one line per meaningful event, no spinners, no
 * redraw, no color (the theme is already colorless in this mode). Deterministic and easy to
 * grep or pipe into another tool. The final summary is rendered separately by the caller.
 */
export class PlainReporter extends BaseReporter implements Reporter {
  constructor(deps: ReporterDeps) {
    super(deps);
  }

  onEvent(event: TendEvent): void {
    const { glyph } = this.theme;
    switch (event.type) {
      case "scan-start":
        this.write(
          event.loop === 1
            ? "initial audit: scanning…"
            : `re-audit after fix pass ${event.loop - 1}: scanning…`,
        );
        break;
      case "scanner-start":
        this.write(`scanner ${event.tool}: running`);
        break;
      case "scanner-result": {
        const count = event.status === "ran" ? ` ${event.findings} findings` : "";
        const reason = event.reason ? ` — ${event.reason}` : "";
        this.write(`scanner ${event.tool}: ${event.status}${count}${reason}`);
        break;
      }
      case "audit": {
        const scope = event.scanned != null ? `${event.scanned} files eligible for fixes` : "whole repo";
        const phase = event.loop === 1 ? "initial audit" : `re-audit after fix pass ${event.loop - 1}`;
        this.write(`${glyph.scanned} ${phase}: fix scope ${scope} ${glyph.bullet} in-scope findings ${event.findings} across ${event.files} files`);
        break;
      }
      case "loop-start":
        this.write(`fix pass ${event.loop} ${glyph.bullet} ${event.files.length} files ${glyph.bullet} ${event.concurrency} concurrent`);
        break;
      case "file-result":
        if (event.outcome === "fixed") this.write(`${glyph.fixed} fixed ${event.file}`);
        else if (event.outcome === "reverted") this.write(`${glyph.reverted} reverted ${event.file} — ${reasonLabel(event.reason)}`);
        else this.write(`${glyph.left} not attempted ${event.file}`);
        break;
      case "file-stage":
        this.write(`progress ${event.file}: ${fixStageLabel(event.stage)}${event.detail ? ` (${event.detail})` : ""}`);
        break;
      // file-start is folded into file-stage/file-result; snapshot/detected arrive as start() notes;
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
