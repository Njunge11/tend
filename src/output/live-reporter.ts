import { basename } from "node:path";
import {
  Listr,
  ListrDefaultRendererLogLevels as Level,
  type PresetTimer,
} from "listr2";
import type { TendEvent } from "./events.js";
import { formatClock } from "./format.js";
import type { Reporter, ReporterDeps } from "./reporter.js";
import type { Theme } from "./theme.js";

type AuditData = { findings: number; files: number; scanned?: number };
type FixInfo = { files: string[]; concurrency: number };
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
export class LiveReporter implements Reporter {
  private readonly theme: Theme;
  private readonly write: (line: string) => void;

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
  private currentFile?: string;
  private currentConcurrency?: number;
  private readonly rules = new Map<string, string>();
  private header?: { title: string };
  private labelWidth = 0;

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
    switch (event.type) {
      case "audit":
        this.audits.push({
          findings: event.findings,
          files: event.files,
          scanned: event.scanned,
        });
        break;
      case "loop-start":
        // Reset counters here (synchronously, before any file-start for this loop) so the
        // header counts stay correct no matter how events interleave with rendering.
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
          info: { files: event.files, concurrency: event.concurrency },
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
      case "snapshot":
      case "detected":
      case "scan-start":
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
        lazy: true,
        showErrorMessage: false,
        timer,
        icon: {
          [Level.COMPLETED]: this.theme.fixed(this.theme.glyph.fixed),
          [Level.FAILED]: this.theme.reverted(this.theme.glyph.reverted),
        },
        // The single accent: the active spinner.
        color: { [Level.PENDING]: (message?: string) => accent(message ?? "") },
      },
    };
  }

  private scannedTitle(a: AuditData): string {
    const scanned = a.scanned != null ? `${a.scanned} files ` : "";
    const meta = this.theme.dim(
      `${this.theme.glyph.bullet} ${a.findings} findings ${this.theme.glyph.bullet} ${a.files} files`,
    );
    return `scanned ${scanned}${meta}`;
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
    return `fixing ${this.finished}/${this.fixTotal} ${this.theme.dim(`${bullet} ${running} running ${bullet} ${queued} queued ${bullet} ${outcomes} ${parallel}${current}`)}`;
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
