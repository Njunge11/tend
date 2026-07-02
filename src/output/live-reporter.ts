import { basename } from "node:path";
import {
  Listr,
  ListrDefaultRendererLogLevels as Level,
  type PresetTimer,
} from "listr2";
import type { Tool } from "../findings/finding.js";
import { fixStageLabel, type FixStage } from "../fixing/progress.js";
import type { ScannerStatusKind } from "../scanners/scanner.js";
import { BaseReporter } from "./base-reporter.js";
import type { AuditExclusions, FixPhase, TendEvent } from "./events.js";
import { fixPhaseLabel, formatAuditFunnel, formatClock } from "./format.js";
import type { Reporter, ReporterDeps } from "./reporter.js";

type AuditData = {
  loop: number;
  findings: number;
  files: number;
  scanned?: number;
  eligible?: number;
  excluded?: AuditExclusions;
};
type FixInfo = { loop: number; phase: FixPhase; files: string[]; concurrency: number };
// The ordered stream of view transitions. One channel keeps scan/fix/done sequencing exactly
// as emitted — a loop may run two fix phases back to back (deterministic, then AI) with no
// scan in between, so the view must not assume scan → fix alternation.
type ControlSignal =
  | { kind: "scan"; loop: number }
  | { kind: "audit"; data: AuditData }
  | { kind: "fix"; info: FixInfo }
  | { kind: "done" };
// Progress inside one fix phase. `complete` carries a title snapshot taken at loop-complete
// time so a lagging redraw can't render the next phase's freshly-reset counters instead.
type FixSignal = { kind: "tick" } | { kind: "complete"; finalTitle: string };
type ScannerLiveStatus = "running" | ScannerStatusKind;
type ScannerInfo = { status: ScannerLiveStatus; findings?: number; reason?: string };

/** A one-shot value channel: take() resolves now if buffered, else when the next push lands. */
class Channel<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: ((value: T) => void)[] = [];

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.buffer.push(value);
  }

  take(): Promise<T> {
    if (this.buffer.length > 0)
      return Promise.resolve(this.buffer.shift() as T);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

const CLOSED = Symbol("closed");

/**
 * The live TTY view. Scanning shows a spinner with elapsed time; fixing shows one compact
 * redrawing listr2 progress row: fixed/total findings · reverted · the current file's
 * rule, stage, model, and elapsed time.
 *
 * Events arrive synchronously on the bus while the orchestrator runs; this reporter buffers
 * them into channels and drives a sequence of listr instances (scan → fix → scan → …) from
 * `run()`, which the caller awaits concurrently with the orchestration.
 */
export class LiveReporter extends BaseReporter implements Reporter {
  private readonly env: ReporterDeps["env"];

  private readonly control = new Channel<ControlSignal>();
  private readonly fixSignals = new Channel<FixSignal>();

  private closed = false;
  private resolveClosed!: () => void;
  private readonly closedSignal = new Promise<typeof CLOSED>((resolve) => {
    this.resolveClosed = () => resolve(CLOSED);
  });

  // Per-phase fix state, reset on each loop-start. We count FINDINGS (issues), not jobs: the
  // denominator is the total findings dispatched this phase, which is stable because findings
  // never split (jobs do). The numerator jumps by a job's finding-count when that job ends.
  private findingsTotal = 0;
  private fixedFindings = 0;
  private revertedFindings = 0;
  private currentLoop = 0;
  private currentPhase: FixPhase = "ai";
  private readonly runningFiles = new Set<string>();
  private readonly fileStartTimes = new Map<string, number>();
  private currentConcurrency?: number;
  private readonly rules = new Map<string, string>();
  private readonly models = new Map<string, string>();
  private readonly stages = new Map<string, FixStage>();
  private readonly stageDetails = new Map<string, string>();
  private readonly scannerStates = new Map<Tool, ScannerInfo>();
  private currentScanLoop?: number;
  private header?: { title: string };
  private scanHeader?: { title: string };
  private labelWidth = 0;
  private cumulativeCostUsd = 0;

  constructor(deps: ReporterDeps) {
    super(deps);
    this.env = deps.env;
  }

  onEvent(event: TendEvent): void {
    switch (event.type) {
      case "audit":
        this.control.push({
          kind: "audit",
          data: {
            loop: event.loop,
            findings: event.findings,
            files: event.files,
            scanned: event.scanned,
            eligible: event.eligible,
            excluded: event.excluded,
          },
        });
        break;
      case "scan-start":
        this.currentScanLoop = event.loop;
        this.scannerStates.clear();
        this.control.push({ kind: "scan", loop: event.loop });
        this.refreshScanHeader();
        break;
      case "scanner-start":
        if (event.loop !== this.currentScanLoop) break;
        this.scannerStates.set(event.tool, { status: "running" });
        this.refreshScanHeader();
        break;
      case "scanner-result":
        if (event.loop !== this.currentScanLoop) break;
        this.scannerStates.set(event.tool, {
          status: event.status,
          findings: event.findings,
          reason: event.reason,
        });
        this.refreshScanHeader();
        break;
      case "loop-start":
        // Reset counters here (synchronously, before any file-start for this loop) so the
        // header counts stay correct no matter how events interleave with rendering.
        this.currentLoop = event.loop;
        this.currentPhase = event.phase;
        this.findingsTotal = event.findings;
        this.fixedFindings = 0;
        this.revertedFindings = 0;
        this.runningFiles.clear();
        this.fileStartTimes.clear();
        this.currentConcurrency = event.concurrency;
        this.rules.clear();
        this.models.clear();
        this.stages.clear();
        this.stageDetails.clear();
        this.labelWidth = Math.max(
          0,
          ...event.files.map((f) => basename(f).length),
        );
        this.control.push({
          kind: "fix",
          info: { loop: event.loop, phase: event.phase, files: event.files, concurrency: event.concurrency },
        });
        break;
      case "file-start":
        this.runningFiles.add(event.file);
        this.fileStartTimes.set(event.file, Date.now());
        if (event.rule) this.rules.set(event.file, event.rule);
        if (event.model) this.models.set(event.file, event.model);
        this.refreshHeader();
        break;
      case "file-stage":
        this.stages.set(event.file, event.stage);
        if (event.detail) this.stageDetails.set(event.file, event.detail);
        else this.stageDetails.delete(event.file);
        this.refreshHeader();
        break;
      case "file-result":
        // Count findings, not jobs. "left" (not attempted / split-parent placeholder) is
        // ignored — those findings roll into the next pass and show in the final summary.
        if (event.outcome === "fixed") this.fixedFindings += event.findings;
        else if (event.outcome === "reverted") this.revertedFindings += event.findings;
        this.runningFiles.delete(event.file);
        this.fileStartTimes.delete(event.file);
        this.refreshHeader();
        this.fixSignals.push({ kind: "tick" });
        break;
      case "loop-complete":
        // Snapshot the final title now, while the counters still describe THIS phase — the
        // next phase's loop-start resets them before a lagging view may get to redraw.
        this.cumulativeCostUsd = event.estimatedCostUsd;
        this.fixSignals.push({ kind: "complete", finalTitle: this.headerTitle() });
        this.refreshHeader();
        break;
      case "done":
        this.control.push({ kind: "done" });
        break;
      case "snapshot":
      case "detected":
        break;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Unblock anything run() may still be awaiting, and end the run cleanly.
    this.control.push({ kind: "done" });
    this.resolveClosed();
  }

  /**
   * Drive the view off the control stream, one signal per step. No scan → fix alternation is
   * assumed: a loop's deterministic and AI fix phases arrive as two consecutive fix signals,
   * and each gets its own progress row. Buffered signals drain before close() wins a race, so
   * a replayed (lagging) run still renders every phase.
   */
  async run(): Promise<void> {
    let carried: ControlSignal | undefined;
    while (true) {
      const signal = carried ?? (await this.race(this.control.take()));
      carried = undefined;
      if (signal === CLOSED || signal.kind === "done") break;
      if (signal.kind === "scan") carried = await this.scanPhase(signal.loop);
      else if (signal.kind === "fix") await this.fixPhase(signal.info);
      // A stray audit with no scan row on screen has nothing to render against; drop it.
    }
  }

  /** Race a promise against close() so the view can wind down even mid-wait. */
  private race<T>(promise: Promise<T>): Promise<T | typeof CLOSED> {
    return Promise.race([promise, this.closedSignal]);
  }

  /** Spinner + elapsed until the audit lands. Returns a non-audit signal it consumed, if any. */
  private async scanPhase(loop: number): Promise<ControlSignal | undefined> {
    let carry: ControlSignal | undefined;
    const list = new Listr<unknown>(
      [
        {
          title: this.scanTitle(loop),
          task: async (_ctx, task) => {
            this.scanHeader = task;
            const next = await this.race(this.control.take());
            this.scanHeader = undefined;
            if (next === CLOSED) return;
            if (next.kind === "audit") task.title = this.scannedTitle(next.data);
            else carry = next;
          },
        },
      ],
      this.listrOptions(),
    );
    await list.run();
    return carry;
  }

  /** The redrawing progress row for one fix phase. Counters are reset by loop-start. */
  private async fixPhase(info: FixInfo): Promise<void> {
    const list = new Listr<unknown>(
      [
        {
          title: this.headerTitle(),
          task: async (_ctx, task) => {
            this.header = task;
            this.currentLoop = info.loop;
            this.currentPhase = info.phase;
            this.currentConcurrency = info.concurrency;
            task.title = this.headerTitle();
            while (true) {
              const signal = await this.race(this.fixSignals.take());
              if (signal === CLOSED) return;
              task.title = signal.kind === "complete" ? signal.finalTitle : this.headerTitle();
              if (signal.kind === "complete") break;
            }
          },
        },
      ],
      this.listrOptions(),
    );
    await list.run();
    this.header = undefined;
  }

  private listrOptions() {
    const accent = this.theme.accent;
    const icon = {
      [Level.COMPLETED]: this.theme.fixed(this.theme.glyph.fixed),
      [Level.FAILED]: this.theme.reverted(this.theme.glyph.reverted),
    };
    const color = { [Level.PENDING]: (message?: string) => accent(message ?? "") };
    const timer: PresetTimer = {
      field: (duration: number) => formatClock(duration),
      format: () => (message?: string) => this.theme.dim(message ?? ""),
    };
    return {
      concurrent: false,
      exitOnError: false,
      // Each phase is its own Listr; don't pile up a SIGINT listener per phase.
      registerSignalListeners: false,
      rendererOptions: {
        collapseSubtasks: true,
        // In a real TTY, let Listr animate its spinner. In captured/fallback output, stay lazy
        // so redraws do not turn into duplicate persisted lines.
        lazy: !this.env.interactive,
        showErrorMessage: false,
        timer,
        icon,
        // The single accent: the active spinner.
        color,
      },
    };
  }

  private scannedTitle(a: AuditData): string {
    const scope = a.scanned != null ? `${a.scanned} files eligible for fixes` : "whole repo";
    const label = a.loop === 1 ? "initial audit" : `re-audit after fix pass ${a.loop - 1}`;
    const funnel = formatAuditFunnel(a.eligible, a.excluded, this.theme.glyph.arrow);
    const meta = this.theme.dim(
      `${label}: fix scope ${scope} ${this.theme.glyph.bullet} in-scope findings ${a.findings} across ${a.files} files${funnel}`,
    );
    return meta;
  }

  private scanTitle(loop: number): string {
    const detail = this.scannerDetail();
    return this.theme.dim(
      loop === 1
        ? `initial audit: scanning…${detail}`
        : `re-audit after fix pass ${loop - 1}: scanning…${detail}`,
    );
  }

  private scannerDetail(): string {
    const entries = [...this.scannerStates.entries()];
    if (entries.length === 0) return "";
    const running = entries.filter(([, info]) => info.status === "running");
    const done = entries.length - running.length;
    if (running.length === 0) return ` ${this.theme.glyph.bullet} scanners ${done}/${entries.length} done`;
    const runningTools = running.map(([tool]) => tool).join(", ");
    return ` ${this.theme.glyph.bullet} running ${runningTools} ${this.theme.glyph.bullet} ${done}/${entries.length} done`;
  }

  private headerTitle(): string {
    const bullet = this.theme.glyph.bullet;
    const cost = this.cumulativeCostUsd > 0 ? ` ${bullet} $${this.cumulativeCostUsd.toFixed(2)}` : "";
    const runningList = [...this.runningFiles];
    const current = runningList.length > 0
      ? runningList.map((f) => this.fileTitle(f)).join(` ${bullet} `)
      : "";
    const currentSuffix = current ? ` ${bullet} ${current}` : "";
    const detail = this.theme.dim(`${cost}${currentSuffix}`);
    // Each phase of a loop renders its own labeled row (auto-fix, then AI); the denominator is
    // that phase's dispatched findings, not the audit's in-scope total — so the phase rows sum
    // to the run summary's fixed count instead of leaving an unexplained gap.
    return `fix pass ${this.currentLoop} ${bullet} ${fixPhaseLabel(this.currentPhase)} ${bullet} ${this.fixedFindings}/${this.findingsTotal} fixed ${bullet} ${this.revertedFindings} reverted${detail}`;
  }

  private refreshHeader(): void {
    if (this.header) this.header.title = this.headerTitle();
  }

  private refreshScanHeader(): void {
    if (this.scanHeader && this.currentScanLoop !== undefined)
      this.scanHeader.title = this.scanTitle(this.currentScanLoop);
  }

  private fileLabel(file: string): string {
    return basename(file).padEnd(this.labelWidth);
  }

  private fileTitle(file: string): string {
    const rule = this.rules.get(file);
    const stage = this.stages.get(file);
    const model = this.models.get(file);
    const startTime = this.fileStartTimes.get(file);
    const elapsed = startTime ? formatClock(Date.now() - startTime) : undefined;
    const detail = [rule, stage ? fixStageLabel(stage) : undefined, this.stageDetails.get(file), model, elapsed]
      .filter(Boolean)
      .join(" · ");
    const suffix = detail ? `  ${this.theme.dim(detail)}` : "";
    return `${this.fileLabel(file)}${suffix}`;
  }
}
