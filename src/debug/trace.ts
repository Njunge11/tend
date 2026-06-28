import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TendEvent } from "../output/events.js";

/**
 * Opt-in step tracer. When `TEND_TRACE_DIR` is set, every key step — the high-level
 * event stream AND each AI session's input/output/result/errors — is written to disk
 * so a run can be reconstructed exactly after the fact. Off by default (no env, no cost).
 *
 * Layout under the trace dir:
 *   events.jsonl                          one line per bus event, timestamped (incl. `debug`)
 *   decisions.jsonl                       one line per `debug` event — the orchestrator's verdicts
 *                                         (terminal/retry/skip/split/budget), filtered for easy reading
 *   trace.log                             human-readable one-liner per session AND per decision
 *   sessions/NNN-<file>/prompt.txt        the exact prompt sent to `claude -p` (INPUT)
 *   sessions/NNN-<file>/stdout.json       claude's raw stream-json (OUTPUT — reasoning/edits)
 *   sessions/NNN-<file>/stderr.txt        claude's stderr (ERRORS)
 *   sessions/NNN-<file>/meta.json         model/effort/exitCode/timedOut/durationMs/findings
 *   scanners.jsonl                        one line per scanner invocation (tool/loop/status/count/diagnostics)
 *   scanners/NNN-loopL-<tool>/meta.json   command/exitCode/durationMs/status + diagnostics (e.g. pinned TS)
 *   scanners/NNN-loopL-<tool>/findings.json the exact findings that scanner emitted this invocation
 *   scanners/NNN-loopL-<tool>/stdout.txt  raw scanner subprocess stdout (spawn scanners only)
 *   scanners/NNN-loopL-<tool>/stderr.txt  raw scanner subprocess stderr (spawn scanners only)
 */
export interface Tracer {
  event(event: TendEvent): void;
  session(record: SessionTrace): void;
  scanner(record: ScannerTrace): void;
}

/** One scanner invocation's raw input/output/findings — captured so phantom findings are diagnosable. */
export type ScannerTrace = {
  tool: string;
  loop: number;
  /** Where this scan ran: the audit pass, or a per-unit gate rescan. */
  phase: string;
  status: "ran" | "skipped" | "failed";
  reason?: string;
  /** The exact findings this scanner emitted this invocation (slimmed for readability). */
  findings: { rule: string; file: string; line?: number; severity?: string; message?: string }[];
  /** Spawn scanners only: the resolved command + raw subprocess output. */
  command?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  /** Scanner-specific diagnostics (e.g. sonarjs's pinned TypeScript path/version + lint groups). */
  diagnostics?: Record<string, unknown>;
};

export type SessionTrace = {
  file: string;
  model: string;
  effort: string;
  prompt: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  findings: { tool: string; rule: string }[];
};

function nowIso(): string {
  return new Date().toISOString();
}

function safeName(file: string): string {
  return file.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
}

/** Returns a Tracer when `TEND_TRACE_DIR` is set, otherwise null (tracing disabled). */
export function createTracer(dir: string | undefined): Tracer | null {
  if (!dir) return null;
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "sessions"), { recursive: true });
  const eventsPath = join(dir, "events.jsonl");
  const decisionsPath = join(dir, "decisions.jsonl");
  const scannersPath = join(dir, "scanners.jsonl");
  const logPath = join(dir, "trace.log");
  let sessionCounter = 0;
  let scannerCounter = 0;

  const append = (path: string, line: string): void => {
    try {
      appendFileSync(path, line);
    } catch {
      // Tracing must never break a run; drop on any I/O error.
    }
  };

  append(logPath, `# trace started ${nowIso()}\n`);

  return {
    event(event: TendEvent): void {
      const ts = nowIso();
      append(eventsPath, `${JSON.stringify({ ts, ...event })}\n`);
      // Mirror decision/diagnostic events into a dedicated, filterable stream + a human line, so a
      // real run's "why" (terminal vs retry, skipped tools, batch split, deterministic edits) is
      // legible without grepping the full event firehose.
      if (event.type === "debug") {
        append(decisionsPath, `${JSON.stringify({ ts, ...event })}\n`);
        const loopTag = event.loop != null ? ` loop=${event.loop}` : "";
        const detailTag = event.detail ? ` ${event.detail}` : "";
        const dataTag = event.data ? ` ${JSON.stringify(event.data)}` : "";
        append(logPath, `${ts} decision${loopTag} ${event.action}${detailTag}${dataTag}\n`);
      }
    },
    session(record: SessionTrace): void {
      const n = String(++sessionCounter).padStart(3, "0");
      const dirName = join(dir, "sessions", `${n}-${safeName(record.file)}`);
      try {
        mkdirSync(dirName, { recursive: true });
        writeFileSync(join(dirName, "prompt.txt"), record.prompt);
        writeFileSync(join(dirName, "stdout.json"), record.stdout);
        writeFileSync(join(dirName, "stderr.txt"), record.stderr);
        writeFileSync(
          join(dirName, "meta.json"),
          JSON.stringify(
            {
              ts: nowIso(),
              file: record.file,
              model: record.model,
              effort: record.effort,
              exitCode: record.exitCode,
              timedOut: record.timedOut,
              durationMs: record.durationMs,
              findings: record.findings,
              stdoutBytes: record.stdout.length,
              stderrBytes: record.stderr.length,
            },
            null,
            2,
          ),
        );
      } catch {
        // ignore trace write failures
      }
      append(
        logPath,
        `${nowIso()} session#${n} ${record.file} model=${record.model} effort=${record.effort} ` +
          `exit=${record.exitCode}${record.timedOut ? " TIMED_OUT" : ""} ${Math.round(record.durationMs / 1000)}s ` +
          `out=${record.stdout.length}b err=${record.stderr.length}b ` +
          `rules=[${record.findings.map((f) => `${f.tool}/${f.rule}`).join(",")}]\n`,
      );
    },
    scanner(record: ScannerTrace): void {
      const ts = nowIso();
      const n = String(++scannerCounter).padStart(3, "0");
      // Compact index line for grepping: which scanner emitted how many findings, where, and why.
      append(
        scannersPath,
        `${JSON.stringify({
          ts,
          n,
          tool: record.tool,
          loop: record.loop,
          phase: record.phase,
          status: record.status,
          reason: record.reason,
          findings: record.findings.length,
          rules: [...new Set(record.findings.map((f) => f.rule))],
          exitCode: record.exitCode,
          durationMs: record.durationMs,
          diagnostics: record.diagnostics,
        })}\n`,
      );
      const dirName = join(dir, "scanners", `${n}-loop${record.loop}-${safeName(record.tool)}`);
      try {
        mkdirSync(dirName, { recursive: true });
        writeFileSync(
          join(dirName, "meta.json"),
          JSON.stringify(
            {
              ts,
              tool: record.tool,
              loop: record.loop,
              phase: record.phase,
              status: record.status,
              reason: record.reason,
              findingsCount: record.findings.length,
              command: record.command,
              exitCode: record.exitCode,
              durationMs: record.durationMs,
              diagnostics: record.diagnostics,
            },
            null,
            2,
          ),
        );
        writeFileSync(join(dirName, "findings.json"), JSON.stringify(record.findings, null, 2));
        if (record.stdout !== undefined) writeFileSync(join(dirName, "stdout.txt"), record.stdout);
        if (record.stderr !== undefined) writeFileSync(join(dirName, "stderr.txt"), record.stderr);
      } catch {
        // ignore trace write failures
      }
      const tsTag = record.diagnostics?.["pinnedTypeScript"]
        ? ` ts=${record.diagnostics["pinnedTypeScript"]}`
        : "";
      append(
        logPath,
        `${ts} scanner#${n} ${record.tool} loop=${record.loop} ${record.phase} ${record.status}` +
          `${record.reason ? ` (${record.reason})` : ""} findings=${record.findings.length}` +
          `${record.exitCode != null ? ` exit=${record.exitCode}` : ""}${tsTag}\n`,
      );
    },
  };
}
