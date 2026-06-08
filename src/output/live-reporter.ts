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
import type { TendEvent } from "./events.js";
import { formatClock } from "./format.js";
import type { Reporter, ReporterDeps } from "./reporter.js";

type AuditData = { loop: number; findings: number; files: number; scanned?: number };
type FixInfo = { loop: number; files: string[]; concurrency: number };
type Phase = { kind: "fix"; info: FixInfo } | { kind: "done" };
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
 * redrawing listr2 progress row with X-of-Y · running · queued · outcome counts.
 *
 * Events arrive synchronously on the bus while the orchestrator runs; this reporter buffers
 * them into channels and drives a sequence of listr instances (scan → fix → scan → …) from
 * `run()`, which the caller awaits concurrently with the orchestration.
 */
export class LiveReporter extends BaseReporter implements Reporter {
  private readonly env: ReporterDeps["env"];

  private readonly scanStarts = new Channel<number>();
  private readonly audits = new Channel<AuditData>();
  private readonly phases = new Channel<Phase>();
  private readonly fixTicks = new Channel<void>();
  private readonly loopCompletions = new Channel<number>();

  private closed = false;
  private resolveClosed!: () => void;
  private readonly closedSignal = new Promise<typeof CLOSED>((resolve) => {
    this.resolveClosed = () => resolve(CLOSED);
  });

  // Per-loop fix state, reset on each loop-start.
  private fixTotal = 0;
  private started = 0;
  private finished = 0;
  private fixed = 0;
  private reverted = 0;
  private notAttempted = 0;
  private currentLoop = 0;
  private readonly runningFiles = new Set<string>();
  private readonly fileStartTimes = new Map<string, number>();
  private currentConcurrency?: number;
  private readonly rules = new Map<string, string>();
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
        this.audits.push({
          loop: event.loop,
          findings: event.findings,
          files: event.files,
          scanned: event.scanned,
        });
        break;
      case "scan-start":
        this.currentScanLoop = event.loop;
        this.scannerStates.clear();
        this.scanStarts.push(event.loop);
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
        this.fixTotal = event.files.length;
        this.started = 0;
        this.finished = 0;
        this.fixed = 0;
        this.reverted = 0;
        this.notAttempted = 0;
        this.runningFiles.clear();
        this.fileStartTimes.clear();
        this.currentConcurrency = event.concurrency;
        this.rules.clear();
        this.stages.clear();
        this.stageDetails.clear();
        this.labelWidth = Math.max(
          0,
          ...event.files.map((f) => basename(f).length),
        );
        this.phases.push({
          kind: "fix",
          info: { loop: event.loop, files: event.files, concurrency: event.concurrency },
        });
        break;
      case "file-start":
        this.started += 1;
        this.fixTotal = Math.max(this.fixTotal, this.started);
        this.runningFiles.add(event.file);
        this.fileStartTimes.set(event.file, Date.now());
        if (event.rule) this.rules.set(event.file, event.rule);
        this.refreshHeader();
        break;
      case "file-stage":
        this.stages.set(event.file, event.stage);
        if (event.detail) this.stageDetails.set(event.file, event.detail);
        else this.stageDetails.delete(event.file);
        this.refreshHeader();
        break;
      case "file-result":
        this.finished += 1;
        this.fixTotal = Math.max(this.fixTotal, this.started, this.finished);
        if (event.outcome === "fixed") this.fixed += 1;
        else if (event.outcome === "reverted") this.reverted += 1;
        else this.notAttempted += 1;
        this.runningFiles.delete(event.file);
        this.fileStartTimes.delete(event.file);
        this.refreshHeader();
        this.fixTicks.push();
        break;
      case "loop-complete":
        this.cumulativeCostUsd = event.estimatedCostUsd;
        this.loopCompletions.push(event.loop);
        this.refreshHeader();
        break;
      case "done":
        this.phases.push({ kind: "done" });
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
    this.phases.push({ kind: "done" });
    this.resolveClosed();
  }

  async run(): Promise<void> {
    while (!this.closed) {
      const stillRunning = await this.scanPhase();
      if (!stillRunning) break;
      const phase = await this.race(this.phases.take());
      if (phase === CLOSED || phase.kind === "done") break;
      await this.fixPhase(phase.info);
    }
  }

  /** Race a promise against close() so the view can wind down even mid-wait. */
  private race<T>(promise: Promise<T>): Promise<T | typeof CLOSED> {
    return Promise.race([promise, this.closedSignal]);
  }

  /** Spinner + elapsed until the next audit lands. Returns false if we were closed first. */
  private async scanPhase(): Promise<boolean> {
    let live = true;
    const list = new Listr<unknown>(
      [
        {
          title: this.theme.dim("scanning…"),
          task: async (_ctx, task) => {
            this.scanHeader = task;
            const loop = await this.race(this.scanStarts.take());
            if (loop === CLOSED) {
              live = false;
              return;
            }
            task.title = this.scanTitle(loop);
            const audit = await this.race(this.audits.take());
            if (audit === CLOSED) {
              live = false;
              return;
            }
            task.title = this.scannedTitle(audit);
            this.scanHeader = undefined;
          },
        },
      ],
      this.listrOptions(),
    );
    await list.run();
    return live;
  }

  /** The redrawing progress row for one fix loop. Counters are reset by loop-start. */
  private async fixPhase(info: FixInfo): Promise<void> {
    const list = new Listr<unknown>(
      [
        {
          title: this.headerTitle(),
          task: async (_ctx, task) => {
            this.header = task;
            this.currentLoop = info.loop;
            this.currentConcurrency = info.concurrency;
            task.title = this.headerTitle();
            while (true) {
              const tickOrComplete = await this.race(
                Promise.race([
                  this.fixTicks.take().then(() => "tick" as const),
                  this.loopCompletions.take().then(() => "complete" as const),
                ]),
              );
              if (tickOrComplete === CLOSED) return;
              task.title = this.headerTitle();
              if (tickOrComplete === "complete") break;
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
    const meta = this.theme.dim(
      `${label}: fix scope ${scope} ${this.theme.glyph.bullet} in-scope findings ${a.findings} across ${a.files} files`,
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
    const running = Math.max(0, this.started - this.finished);
    const queued = Math.max(0, this.fixTotal - this.started);
    const bullet = this.theme.glyph.bullet;
    const outcomes = `${this.fixed} fixed ${bullet} ${this.reverted} reverted`;
    const cost = this.cumulativeCostUsd > 0 ? ` ${bullet} $${this.cumulativeCostUsd.toFixed(2)}` : "";
    const runningList = [...this.runningFiles];
    const current = runningList.length > 0
      ? runningList.map((f) => this.fileTitle(f)).join(` ${bullet} `)
      : "";
    const detail = `${bullet} ${running} running ${bullet} ${queued} queued ${bullet} ${outcomes}${cost}${current ? ` ${bullet} ${current}` : ""}`;
    return `fix pass ${this.currentLoop} ${this.finished}/${this.fixTotal} ${this.theme.dim(detail)}`;
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
    const startTime = this.fileStartTimes.get(file);
    const elapsed = startTime ? formatClock(Date.now() - startTime) : undefined;
    const detail = [rule, stage ? fixStageLabel(stage) : undefined, this.stageDetails.get(file), elapsed]
      .filter(Boolean)
      .join(" · ");
    const suffix = detail ? `  ${this.theme.dim(detail)}` : "";
    return `${this.fileLabel(file)}${suffix}`;
  }
}
