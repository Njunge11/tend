import { basename } from "node:path";
import {
  Listr,
  ListrDefaultRendererLogLevels as Level,
  type PresetTimer,
} from "listr2";
import { BaseReporter } from "./base-reporter.js";
import type { TendEvent } from "./events.js";
import { formatClock } from "./format.js";
import type { Reporter, ReporterDeps } from "./reporter.js";

type AuditData = { loop: number; findings: number; files: number; scanned?: number };
type FixInfo = { loop: number; files: string[]; concurrency: number };
type Phase = { kind: "fix"; info: FixInfo } | { kind: "done" };

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
  private left = 0;
  private currentLoop = 0;
  private currentFile?: string;
  private currentConcurrency?: number;
  private readonly rules = new Map<string, string>();
  private header?: { title: string };
  private labelWidth = 0;

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
      case "loop-start":
        // Reset counters here (synchronously, before any file-start for this loop) so the
        // header counts stay correct no matter how events interleave with rendering.
        this.currentLoop = event.loop;
        this.fixTotal = event.files.length;
        this.started = 0;
        this.finished = 0;
        this.fixed = 0;
        this.reverted = 0;
        this.left = 0;
        this.currentFile = undefined;
        this.currentConcurrency = event.concurrency;
        this.rules.clear();
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
        this.currentFile = event.file;
        if (event.rule) this.rules.set(event.file, event.rule);
        this.refreshHeader();
        break;
      case "file-result":
        this.finished += 1;
        if (event.outcome === "fixed") this.fixed += 1;
        else if (event.outcome === "reverted") this.reverted += 1;
        else this.left += 1;
        this.currentFile = undefined;
        this.refreshHeader();
        this.fixTicks.push();
        break;
      case "done":
        this.phases.push({ kind: "done" });
        break;
      case "scan-start":
        this.scanStarts.push(event.loop);
        break;
      case "snapshot":
      case "detected":
      case "loop-complete":
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
            while (this.finished < this.fixTotal) {
              const tick = await this.race(this.fixTicks.take());
              if (tick === CLOSED) return;
              task.title = this.headerTitle();
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
    return this.theme.dim(
      loop === 1
        ? "initial audit: scanning…"
        : `re-audit after fix pass ${loop - 1}: scanning…`,
    );
  }

  private headerTitle(): string {
    const running = Math.max(0, this.started - this.finished);
    const queued = Math.max(0, this.fixTotal - this.started);
    const bullet = this.theme.glyph.bullet;
    const outcomes = `${this.fixed} fixed ${bullet} ${this.reverted} reverted ${bullet} ${this.left} left`;
    const parallel = this.currentConcurrency
      ? `${bullet} ${this.currentConcurrency} concurrent `
      : "";
    const current = this.currentFile
      ? `${bullet} ${this.fileTitle(this.currentFile)}`
      : "";
    const detail = `${bullet} ${running} running ${bullet} ${queued} queued ${bullet} ${outcomes} ${parallel}${current}`;
    return `fix pass ${this.currentLoop} ${this.finished}/${this.fixTotal} ${this.theme.dim(detail)}`;
  }

  private refreshHeader(): void {
    if (this.header) this.header.title = this.headerTitle();
  }

  private fileLabel(file: string): string {
    return basename(file).padEnd(this.labelWidth);
  }

  private fileTitle(file: string): string {
    const rule = this.rules.get(file);
    const suffix = rule ? `  ${this.theme.dim(rule)}` : "";
    return `${this.fileLabel(file)}${suffix}`;
  }
}
