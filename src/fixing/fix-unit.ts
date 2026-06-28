import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Finding, Tool } from "../findings/finding.js";
import { parseTscErrors } from "../gate/checks/typecheck.js";
import type { RevertReason } from "../gate/check.js";
import type { FixOutcome } from "../orchestrator.js";
import {
  addUsage,
  zeroUsage,
  type AiUsage,
  type FailureClass,
  type SessionRequest,
  type SessionResult,
  type SessionRunner,
} from "../session/types.js";
import type { WorkUnit } from "./dispatch.js";
import { fixStageLabel, type FixProgressEvent, type FixStage } from "./progress.js";
import type { RepairStrategy } from "./repair-strategy.js";
import {
  buildDiff,
  gateUnitChanges,
  restoreSnapshot,
  snapshotUnitNow,
  snapshotUnitFiles,
  unitChanged,
  type UnitGateDeps,
} from "./unit-gate.js";

export type FixUnitDeps = UnitGateDeps & {
  session: SessionRunner;
  maxRepairs: number;
  onProgress?: (event: FixProgressEvent) => void;
  /** Hard cap for one AI session. Defaults to the production child-process timeout. */
  sessionTimeoutMs?: number;
  /** Global run cancellation (Ctrl-C): aborts the in-flight AI session's subprocess. */
  cancelSignal?: AbortSignal;
  /** Hard cap for a gate pass. Individual subprocesses also have their own timeouts. */
  gateTimeoutMs?: number;
};

const DEFAULT_SESSION_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_GATE_TIMEOUT_MS = 30 * 60_000;
/**
 * After a session timeout fires we abort, then wait this long for the aborted session to settle
 * and report whatever usage it accrued before the kill (so the timeout bills its partial cost).
 * A session that never settles within the window falls back to zero usage.
 */
const SETTLE_GRACE_MS = 1_000;

function readPromptTemplate(name: string): string {
  const path =
    [
      resolve(dirname(fileURLToPath(import.meta.url)), `../../prompts/${name}`),
      resolve(dirname(fileURLToPath(import.meta.url)), `../prompts/${name}`),
    ].find(existsSync) ??
    resolve(dirname(fileURLToPath(import.meta.url)), `../prompts/${name}`);
  return readFileSync(path, "utf8");
}

const FIX_PROMPT_TEMPLATE = readPromptTemplate("fix.md");
const SINGLE_FILE_AI_EDIT_PROMPT_TEMPLATE = readPromptTemplate("single-file-ai-edit.md");
const REGRESSION_REPAIR_PROMPT_TEMPLATE = readPromptTemplate("regression-repair.md");
const MULTI_FILE_DUPLICATE_PROMPT_TEMPLATE = readPromptTemplate("multi-file-duplicate-refactor.md");
const GENERATED_SOURCE_PROMPT_TEMPLATE = readPromptTemplate("generated-source-repair.md");
const TEST_FILE_REPAIR_PROMPT_TEMPLATE = readPromptTemplate("test-file-repair.md");
const DEAD_CODE_CLEANUP_PROMPT_TEMPLATE = readPromptTemplate("dead-code-cleanup.md");
const INTEGRATION_REPAIR_PROMPT_TEMPLATE = readPromptTemplate("integration-repair.md");

function replaceAllLiteral(input: string, search: string, replacement: string): string {
  return input.split(search).join(replacement);
}

/** Fill every `{{key}}` placeholder in a template from a map of key → rendered value. */
function fillTemplate(template: string, replacements: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(replacements)) {
    out = replaceAllLiteral(out, `{{${key}}}`, value);
  }
  return out;
}

type FixPromptStrategy = RepairStrategy | "regression-repair";

function formatDuration(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms >= 1_000 && ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timeoutEnabled(ms: number | undefined): ms is number {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0;
}

function isDeadCodeUnit(unit: WorkUnit): boolean {
  return (
    unit.findings.length > 0 &&
    unit.findings.every(
      (finding) => finding.category === "dead-code" || (finding.tool === "knip" && finding.rule.startsWith("unused-")),
    )
  );
}

function isMechanicalUnit(unit: WorkUnit): boolean {
  return unit.findings.every(
    (f) => f.category === "dead-code" || f.autofixable === true,
  );
}

function promptStrategyFor(unit: WorkUnit): FixPromptStrategy {
  if (unit.strategy) return unit.strategy;
  if (isDeadCodeUnit(unit)) return "dead-code-cleanup";
  return "single-file-ai-edit";
}

function templateForStrategy(strategy: FixPromptStrategy): string {
  if (strategy === "single-file-ai-edit") return SINGLE_FILE_AI_EDIT_PROMPT_TEMPLATE;
  if (strategy === "multi-file-duplicate-refactor") return MULTI_FILE_DUPLICATE_PROMPT_TEMPLATE;
  if (strategy === "generated-source-repair") return GENERATED_SOURCE_PROMPT_TEMPLATE;
  if (strategy === "test-file-repair") return TEST_FILE_REPAIR_PROMPT_TEMPLATE;
  if (strategy === "dead-code-cleanup") return DEAD_CODE_CLEANUP_PROMPT_TEMPLATE;
  if (strategy === "regression-repair") return REGRESSION_REPAIR_PROMPT_TEMPLATE;
  return FIX_PROMPT_TEMPLATE;
}

function renderFileList(files: string[]): string {
  return files.map((file) => `- ${file}`).join("\n");
}

/**
 * Render the editable files' current source as labelled fenced blocks, so the model can
 * edit without a preliminary Read (Fix 6). Templates that don't reference `{{fileContents}}`
 * are unaffected; an empty map renders a neutral note so the placeholder is never left raw.
 */
function renderFileContents(contents: Map<string, string>): string {
  if (contents.size === 0) return "(file content not supplied — read the file before editing)";
  return [...contents]
    .map(([file, source]) => `### ${file}\n\n\`\`\`\n${source}\n\`\`\``)
    .join("\n\n");
}

/** Editable files' current on-disk content, dropping any that don't exist (null in the snapshot). */
function contentMapFor(snapshot: Map<string, string | null>, files: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of files) {
    const source = snapshot.get(file);
    if (typeof source === "string") out.set(file, source);
  }
  return out;
}

/**
 * One failed repair attempt: the diff it produced and why the gate rejected it. Accumulated so a
 * later attempt sees every dead end it has already walked, not just the most recent — Anthropic
 * prompt guidance §1/§12 (ground the model in the actual prior failures). `newFindings` is empty
 * for non-regression rejections (typecheck/broke-test).
 */
type RepairAttempt = { diff: string; gateOutput: string; newFindings: Finding[] };

/** Render the full failure history as delimited blocks so a retry can avoid re-walking dead ends. */
function renderAttemptHistory(attempts: RepairAttempt[]): string {
  if (attempts.length === 0) return "(no prior attempts — this is the first repair)";
  return attempts
    .map((attempt, i) => {
      const parts = [
        `### Attempt ${i + 1} (rejected)`,
        `<rejected_diff>\n\`\`\`diff\n${firstRelevantLines(attempt.diff, 80)}\n\`\`\`\n</rejected_diff>`,
      ];
      if (attempt.newFindings.length > 0) {
        parts.push(`New findings it introduced:\n<new_findings>\n${renderFindingsJson(attempt.newFindings)}\n</new_findings>`);
      }
      parts.push(`Gate output:\n<gate_output>\n\`\`\`text\n${attempt.gateOutput}\n\`\`\`\n</gate_output>`);
      return parts.join("\n\n");
    })
    .join("\n\n");
}

function renderCommonTemplate(input: {
  template: string;
  strategyName: FixPromptStrategy;
  findings: string;
  editableFiles: string[];
  verificationTargets: string[];
  fileContents?: Map<string, string>;
}): string {
  return replaceAllLiteral(
    replaceAllLiteral(
      replaceAllLiteral(
        replaceAllLiteral(
          replaceAllLiteral(input.template, "{{strategyName}}", input.strategyName),
          "{{findings}}",
          input.findings,
        ),
        "{{editableFiles}}",
        renderFileList(input.editableFiles),
      ),
      "{{verificationTargets}}",
      renderFileList(input.verificationTargets),
    ),
    "{{fileContents}}",
    renderFileContents(input.fileContents ?? new Map()),
  ).trim();
}

/** Render the fix prompt for a unit's findings. `fileContents` supplies on-disk source. */
export function renderPrompt(unit: WorkUnit, fileContents?: Map<string, string>): string {
  const strategyName = promptStrategyFor(unit);
  return renderCommonTemplate({
    template: templateForStrategy(strategyName),
    strategyName,
    findings: renderFindingsJson(unit.findings),
    editableFiles: unit.files,
    verificationTargets: unit.verificationTargets ?? unit.files,
    fileContents,
  });
}

function firstRelevantLines(output: string, max = 20): string {
  const lines = output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  return lines.slice(0, max).join("\n") || "(none)";
}

function renderFindingsJson(findings: Finding[]): string {
  const data = findings.map((f) => ({
    file: f.file,
    range: f.range,
    tool: f.tool,
    rule: f.rule,
    category: f.category,
    severity: f.severity,
    message: f.message,
    helpUri: f.helpUri,
    flowPath: f.flowPath,
  }));
  return ["```json", JSON.stringify(data, null, 2), "```"].join("\n");
}

function renderRegressionRepairPrompt(input: {
  unit: WorkUnit;
  /** Current on-disk content of the editable files, so the repair grounds in the real text (§12). */
  fileContents: Map<string, string>;
  /** Full failure history, oldest first — every prior diff + its exact gate error, not just the last. */
  attempts: RepairAttempt[];
}): string {
  const strategyName = "regression-repair";
  const prompt = renderCommonTemplate({
    template: REGRESSION_REPAIR_PROMPT_TEMPLATE,
    strategyName,
    findings: renderFindingsJson(input.unit.findings),
    editableFiles: input.unit.files,
    verificationTargets: input.unit.verificationTargets ?? input.unit.files,
    fileContents: input.fileContents,
  });
  return replaceAllLiteral(prompt, "{{attemptHistory}}", renderAttemptHistory(input.attempts)).trim();
}

function renderNoEditRetryPrompt(unit: WorkUnit, fileContents?: Map<string, string>): string {
  return `${renderPrompt(unit, fileContents)}

The previous session completed without changing any owned file. Retry once with a smaller, concrete edit:
- Make the minimal behavior-preserving code change that clears the finding.
- If no valid edit is possible within the editable files, leave files unchanged.
- Do not restate the analysis; use Write or Edit only when applying the fix.`;
}

function classFromOutcome(reason: FixOutcome["reason"], fallback?: FailureClass): FailureClass | undefined {
  if (fallback) return fallback;
  if (reason === "regression") return "regression";
  if (reason === "unresolved-target") return "unresolved-target";
  if (reason === "typecheck") return "typecheck";
  if (reason === "broke-test") return "broke-test";
  if (reason === "suppression") return "suppression";
  if (reason === "needs-lockfile-update") return "needs-lockfile-update";
  if (reason === "session-error") return "model-tool-failure";
  return undefined;
}

async function runSessionWithTimeout(
  deps: FixUnitDeps,
  request: SessionRequest,
): Promise<SessionResult> {
  const timeoutMs = deps.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
  const controller = new AbortController();
  // Chain the run-wide cancel signal (Ctrl-C) into this session's controller so the
  // `claude` subprocess is killed instead of running its full course after cancellation.
  const onCancel = (): void => controller.abort();
  if (deps.cancelSignal?.aborted) controller.abort();
  else deps.cancelSignal?.addEventListener("abort", onCancel, { once: true });
  const run = deps.session
    .run({ ...request, signal: controller.signal })
    .catch((error): SessionResult => ({
      ok: false,
      error: errorMessage(error),
      rateLimited: false,
      failureClass: controller.signal.aborted ? "tool-timeout" : "model-tool-failure",
      usage: zeroUsage(),
    }));

  if (!timeoutEnabled(timeoutMs)) {
    try {
      return await run;
    } finally {
      deps.cancelSignal?.removeEventListener("abort", onCancel);
    }
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<SessionResult>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      const timeoutResult = (usage: SessionResult["usage"]): SessionResult => ({
        ok: false,
        error: `AI session timed out after ${formatDuration(timeoutMs)}`,
        rateLimited: false,
        failureClass: "tool-timeout",
        usage: usage ?? zeroUsage(),
      });
      // Give the aborted session a brief window to settle and report whatever usage it accrued
      // before the kill, so a timeout still bills its partial cost instead of a flat zero. A truly
      // hung session that never resolves falls back to zero usage after the grace window.
      const fallback = setTimeout(() => resolve(timeoutResult(zeroUsage())), SETTLE_GRACE_MS);
      run.then(
        (settled) => {
          clearTimeout(fallback);
          resolve(timeoutResult(settled.usage));
        },
        () => {
          clearTimeout(fallback);
          resolve(timeoutResult(zeroUsage()));
        },
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([run, timedOut]);
  } finally {
    if (timeout) clearTimeout(timeout);
    deps.cancelSignal?.removeEventListener("abort", onCancel);
  }
}

async function runGateWithTimeout(
  deps: FixUnitDeps,
  currentStage: () => FixStage | undefined,
  usage: () => AiUsage,
  run: () => Promise<FixOutcome>,
): Promise<FixOutcome> {
  const timeoutMs = deps.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  const work = run();
  // If the deadline wins, keep a rejection from the underlying promise from surfacing
  // as an unhandled rejection later. Production subprocesses have their own kill timeouts.
  work.catch(() => undefined);

  if (!timeoutEnabled(timeoutMs)) {
    try {
      return await work;
    } catch (error) {
      return {
        kept: false,
        reason: "session-error",
        detail: errorMessage(error),
        failureClass: "model-tool-failure",
        usage: usage(),
      };
    }
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<FixOutcome>((resolve) => {
    timeout = setTimeout(() => {
      const stage = currentStage();
      resolve({
        kept: false,
        reason: "session-error",
        detail: `Gate timed out${stage ? " during " + fixStageLabel(stage) : ""} after ${formatDuration(timeoutMs)}`,
        failureClass: "tool-timeout",
        usage: usage(),
      });
    }, timeoutMs);
  });

  try {
    return await Promise.race([work, timedOut]);
  } catch (error) {
    return {
      kept: false,
      reason: "session-error",
      detail: errorMessage(error),
      failureClass: "model-tool-failure",
      usage: usage(),
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

type InitialEditResult =
  | { done: true; outcome: FixOutcome }
  | { done: false; usage: AiUsage };

async function runInitialEditSession(
  deps: FixUnitDeps,
  unit: WorkUnit,
  fileContents: Map<string, string>,
  restore: () => void,
  changedOnDisk: () => boolean,
  initialUsage: AiUsage,
  progress: (stage: FixStage, detail?: string) => void,
): Promise<InitialEditResult> {
  let usage = initialUsage;
  const activity = (stage: FixStage) => (detail: string) => progress(stage, detail);

  progress("ai-edit");
  const res = await runSessionWithTimeout(deps, {
    file: unit.file,
    findings: unit.findings,
    prompt: renderPrompt(unit, fileContents),
    onActivity: activity("ai-edit"),
  });
  if (res.usage) usage = addUsage(usage, res.usage);

  // Files changed but the session errored/crashed → never leave a half-applied edit
  // for the re-scan to call "fixed"; revert to the snapshot.
  if (!res.ok) {
    if (changedOnDisk()) restore();
    return { done: true, outcome: { kept: false, reason: "session-error", detail: res.error, failureClass: res.failureClass, usage } };
  }

  if (changedOnDisk()) return { done: false, usage };

  // No-edit sessions get one stricter retry — unless the unit is mechanical (dead-code,
  // autofixable), where a second attempt won't help and just wastes time.
  if (isMechanicalUnit(unit)) {
    return { done: true, outcome: { kept: false, reason: "session-error", detail: "Mechanical fix session completed without edits", failureClass: "no-op", usage } };
  }

  progress("ai-no-edit-retry");
  const retry = await runSessionWithTimeout(deps, {
    file: unit.file,
    findings: unit.findings,
    prompt: renderNoEditRetryPrompt(unit, fileContents),
    onActivity: activity("ai-no-edit-retry"),
  });
  if (retry.usage) usage = addUsage(usage, retry.usage);
  if (!retry.ok) {
    if (changedOnDisk()) restore();
    return { done: true, outcome: { kept: false, reason: "session-error", detail: retry.error, failureClass: retry.failureClass, usage } };
  }
  if (!changedOnDisk()) {
    return { done: true, outcome: { kept: false, reason: "session-error", detail: "Session completed without changing owned files after stricter retry", failureClass: "no-op", usage } };
  }
  return { done: false, usage };
}

/**
 * Production fix worker. The session edits files directly on disk (`claude -p
 * --allowedTools Read,Write,Edit`), so the **disk is the source of truth** — we
 * snapshot the unit's files before the session and judge by what actually changed,
 * never by the session's stream-json (which can under-report or read as errored even
 * when a file was written). What changed runs the gate (anti-suppression · typecheck ·
 * tests with a bounded repair window · anti-regression re-scan); any gate failure or
 * session error reverts the files to the snapshot. Nothing changed → not a fix.
 */
export function makeFixUnit(deps: FixUnitDeps) {
  return async (unit: WorkUnit, loop = 0): Promise<FixOutcome> => {
    let currentStage: FixStage | undefined;
    const progress = (stage: FixStage, detail?: string): void => {
      currentStage = stage;
      deps.onProgress?.({ loop, file: unit.file, stage, detail });
    };
    const snapshotFiles =
      unit.strategy === "generated-source-repair"
        ? [...new Set([...unit.files, ...(unit.verificationTargets ?? [])])]
        : unit.files;
    const before = snapshotUnitFiles(deps.cwd, snapshotFiles);
    const restore = (): void => restoreSnapshot(deps.cwd, before);
    const changedOnDisk = () => unitChanged(deps.cwd, unit.files, before);

    // The post-fix gate rescans these targets with these tools; cross-file scanners (jscpd)
    // report clones repo-wide, so we baseline what already exists in this scope BEFORE editing.
    const verificationTargets = unit.verificationTargets ?? unit.files;
    const scannerTools = [...new Set(unit.findings.map((finding) => finding.tool))] satisfies Tool[];
    const preexistingIds = new Set((await deps.scanFindings(verificationTargets, scannerTools)).map((f) => f.id));

    // Supply the editable files' current source to the session so it can edit without a
    // preliminary Read (Fix 6). Reuse the pre-session snapshot; missing files are skipped.
    const fileContents = new Map<string, string>();
    for (const file of unit.files) {
      const source = before.get(file);
      if (typeof source === "string") fileContents.set(file, source);
    }

    // Estimated AI cost/usage accumulates across the initial session and any repair
    // sessions — even when the unit ends up reverted or unfixable, the tokens were spent.
    let usage = zeroUsage();

    // Set once any in-dispatch repair session (regression repair / test repair) runs. A revert
    // after a repair already failed the gate, so the orchestrator should not re-dispatch from
    // scratch (which repeats this same fan-out) — see FixOutcome.repairAttempted (item 5).
    let repairAttempted = false;

    // Sessions stream activity while they run; surface it as detail on the live stage so
    // long AI edits show ongoing progress instead of a single static label.
    const activity = (stage: FixStage) => (detail: string) => progress(stage, detail);

    const initialResult = await runInitialEditSession(deps, unit, fileContents, restore, changedOnDisk, usage, progress);
    if (initialResult.done) return initialResult.outcome;
    usage = initialResult.usage;

    async function scanNewFindings(): Promise<Finding[]> {
      progress("rescan");
      const afterFindings = await deps.scanFindings(verificationTargets, scannerTools);
      // Genuinely new findings only — exclude anything that already existed in this scope.
      return afterFindings.filter((f) => !preexistingIds.has(f.id));
    }

    // Every failed attempt (initial edit + each repair) accumulates here so the next repair session
    // sees the whole history of dead ends, not just the most recent one (Fix 3 / §12).
    const repairAttempts: RepairAttempt[] = [];

    async function runRegressionRepair(outcome: FixOutcome): Promise<boolean> {
      if (outcome.reason !== "regression" && outcome.reason !== "typecheck") return false;
      repairAttempted = true;
      const after = snapshotUnitNow(deps.cwd, snapshotFiles);
      repairAttempts.push({
        diff: buildDiff(before, after),
        gateOutput: [`Reason: ${outcome.reason}`, firstRelevantLines(outcome.detail ?? "")].join("\n"),
        newFindings: outcome.reason === "regression" ? await scanNewFindings() : [],
      });
      progress("regression-repair");
      const repair = await runSessionWithTimeout(deps, {
        file: unit.file,
        findings: unit.findings,
        prompt: renderRegressionRepairPrompt({
          unit,
          fileContents: contentMapFor(after, unit.files),
          attempts: repairAttempts,
        }),
        onActivity: activity("regression-repair"),
      });
      if (repair.usage) usage = addUsage(usage, repair.usage);
      if (!repair.ok) {
        repairFailureDetail = `Regression repair session failed: ${repair.error}`;
        return false;
      }
      return changedOnDisk();
    }

    let repairFailureDetail: string | undefined;
    // The repair session also edits the disk directly — just re-run it.
    async function repairBrokenTests(_attempt: number, regressed: Array<{ name: string }>): Promise<void> {
      repairAttempted = true;
      const after = snapshotUnitNow(deps.cwd, snapshotFiles);
      repairAttempts.push({
        diff: buildDiff(before, after),
        gateOutput: `Fix left previously-green test(s) red:\n${regressed.map((test) => test.name).join("\n")}`,
        newFindings: [],
      });
      const repair = await runSessionWithTimeout(deps, {
        file: unit.file,
        findings: unit.findings,
        prompt: renderRegressionRepairPrompt({
          unit,
          fileContents: contentMapFor(after, unit.files),
          attempts: repairAttempts,
        }),
        onActivity: activity("test-repair"),
      });
      if (repair.usage) usage = addUsage(usage, repair.usage);
      if (!repair.ok) repairFailureDetail = `Repair session failed: ${repair.error}`;
    }
    async function gateCurrent(): Promise<FixOutcome> {
      return gateUnitChanges(unit, before, deps, {
        usage,
        preexistingIds,
        // A kept unit is reported "fixed", so the rescan must confirm the target findings are
        // actually gone. Without this, an edit that still trips the rule (same fingerprint, so
        // not "introduced") was kept and marked fixed, only for the next loop's re-audit to flip
        // it back to pending — a false "N/N fixed", a wasted extra pass re-fixing it, and a
        // finding that never burned per-issue budget because no attempt was ever recorded.
        // The deterministic gate already requires this (see deterministic.ts).
        requireResolved: true,
        onProgress: progress,
        repair: repairBrokenTests,
        maxRepairs: deps.maxRepairs,
        repairFailureDetail: () => repairFailureDetail,
      });
    }

    let outcome = await runGateWithTimeout(deps, () => currentStage, () => usage, gateCurrent);
    if (!outcome.kept && (await runRegressionRepair(outcome))) {
      outcome = await runGateWithTimeout(deps, () => currentStage, () => usage, gateCurrent);
    }

    if (!outcome.kept) {
      restore();
      return {
        ...outcome,
        failureClass: classFromOutcome(outcome.reason, outcome.failureClass),
        usage,
        repairAttempted,
      };
    }

    return { ...outcome, usage };
  };
}

// A tsc diagnostic line names its file first: "path(line,col): error TSxxxx: …". Pretty output is
// off when the gate spawns tsc, so this plain single-line form is what we parse for editable files.
const TSC_ERROR_FILE = /^(.+?)\((\d+),(\d+)\): error TS\d+:/;

function normalizeRelPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.?\//, "");
}

/**
 * tsc runs from the owning package root, so its diagnostic paths are relative to THAT — but the
 * repair session edits from the repo root. Rewrite each diagnostic's file path to repo-relative so
 * the model (and the editable-file list) name files the same way regardless of monorepo layout.
 * `ownerRoot === repoRoot` (single-package) makes this an identity map. Returns the rewritten dump
 * and the deduped repo-relative files it named.
 */
function remapTscDiagnostics(
  output: string,
  repoRoot: string,
  ownerRoot: string,
): { output: string; files: string[] } {
  const files = new Set<string>();
  const rewritten = output.split("\n").map((line) => {
    const m = TSC_ERROR_FILE.exec(line.trim());
    if (!m?.[1]) return line;
    const repoRel = normalizeRelPath(relative(repoRoot, resolve(ownerRoot, normalizeRelPath(m[1]))));
    files.add(repoRel);
    return line.replace(m[1], repoRel); // literal first-occurrence swap of the diagnostic's path
  });
  return { output: rewritten.join("\n"), files: [...files] };
}

/** Multiset difference: tsc error signatures in `after` not covered, by count, by `baseline`. */
function newTscErrors(after: readonly string[], baseline: readonly string[]): string[] {
  const remaining = new Map<string, number>();
  for (const s of baseline) remaining.set(s, (remaining.get(s) ?? 0) + 1);
  const fresh: string[] = [];
  for (const s of after) {
    const n = remaining.get(s) ?? 0;
    if (n > 0) remaining.set(s, n - 1);
    else fresh.push(s);
  }
  return fresh;
}

/**
 * One `tsc --noEmit` pass over the integrated tree, judged against the run's pristine baseline so a
 * pre-existing error never counts. `ok` means no NEW error; `output` is the raw tsc dump (for the
 * repair prompt + file extraction). Mirrors the per-unit typecheck gate's semantics exactly, but
 * keeps the raw output instead of collapsing to signatures.
 */
async function integratedTypecheck(deps: UnitGateDeps): Promise<{ ok: boolean; output: string }> {
  const { exitCode, output } = await deps.runTsc();
  if (exitCode === 0) return { ok: true, output };
  // No baseline captured → fail closed on any error (matches the per-unit gate).
  if (deps.typecheckBaseline === undefined) return { ok: false, output: output.trim() || "tsc --noEmit failed" };
  const after = parseTscErrors(output);
  // tsc failed but emitted nothing parseable — a crash/timeout/unexpected format. Fail closed.
  if (after.length === 0) return { ok: false, output: output.trim() || "tsc --noEmit failed" };
  const fresh = newTscErrors(after, deps.typecheckBaseline);
  return { ok: fresh.length === 0, output };
}

/** Render prior failed integration-repair tsc outputs so a retry sees what it already couldn't fix. */
function renderIntegrationHistory(priorOutputs: string[]): string {
  if (priorOutputs.length === 0) return "(no prior attempts — this is the first repair)";
  return priorOutputs
    .map(
      (out, i) =>
        `### Attempt ${i + 1} (still failed)\n<gate_output>\n\`\`\`text\n${firstRelevantLines(out, 80)}\n\`\`\`\n</gate_output>`,
    )
    .join("\n\n");
}

function renderIntegrationRepairPrompt(input: {
  unit: WorkUnit;
  editableFiles: string[];
  /** Current on-disk content of every editable file, so the repair grounds in the real text (§12). */
  fileContents: Map<string, string>;
  gateOutput: string;
  /** tsc output from earlier failed repair attempts this run (empty on the first attempt). */
  priorOutputs: string[];
}): string {
  return fillTemplate(INTEGRATION_REPAIR_PROMPT_TEMPLATE, {
    findings: renderFindingsJson(input.unit.findings),
    editableFiles: renderFileList(input.editableFiles),
    fileContents: renderFileContents(input.fileContents),
    gateDetails: firstRelevantLines(input.gateOutput, 80),
    attemptHistory: renderIntegrationHistory(input.priorOutputs),
  }).trim();
}

export type IntegrationGateDeps = FixUnitDeps & {
  /** Model to force for integration-repair sessions (the capable/Opus tier). Omitted → per-unit routing. */
  repairModel?: string;
  /** Max in-place integration-repair attempts before dropping the fix. Defaults to 1. */
  maxIntegrationRepairs?: number;
  /**
   * The owning package root tsc runs in. tsc emits paths relative to it, but the repair session
   * edits from the repo root (`deps.cwd`), so the gate maps diagnostics to repo-relative. Defaults
   * to `deps.cwd` (single-package / whole-repo runs, where the two roots coincide).
   */
  ownerRoot?: string;
};

export type IntegrationGateResult = {
  kept: boolean;
  reason?: RevertReason;
  detail?: string;
  usage: AiUsage;
  /** Files OTHER than the fix's own that the integration-repair session edited — the caller must
   *  revert these to the known-good base when the fix is dropped (the gate only restores its own). */
  repairedFiles: string[];
};

/**
 * The integrated acceptance gate. An accepted fix is verified in its ISOLATED sandbox (fast,
 * parallel), then this runs against the REAL combined tree — base + every fix accepted so far this
 * run — which the per-unit gate structurally can't see. Two individually-clean fixes can combine
 * into a tree that no longer type-checks (e.g. two narrowings make a third file's `a === b` have no
 * overlap → TS2367). On such a NEW error this routes the tsc output into an in-place repair session
 * (capable tier) so the model reconciles the integration while keeping ALL fixes landed, then
 * re-gates — bounded by `maxIntegrationRepairs`. Only if repair genuinely can't does it drop THIS
 * one fix (restoring its files to `beforeFix`; the caller reverts any other file the repair touched),
 * never sinking the rest of the batch. Run inside the pool's serialized integration section so the
 * tree it verifies can't shift under it.
 */
export function makeIntegrationGate(deps: IntegrationGateDeps) {
  const maxRepairs = deps.maxIntegrationRepairs ?? 1;
  return async (
    unit: WorkUnit,
    /** The fix's own files, snapshotted BEFORE its patch landed — the precise pre-fix revert target. */
    beforeFix: Map<string, string | null>,
    startUsage: AiUsage,
    progress?: (stage: FixStage, detail?: string) => void,
  ): Promise<IntegrationGateResult> => {
    let usage = startUsage;
    // No TS project → the integrated typecheck has nothing to catch; accept as-is.
    if (!deps.typescript) return { kept: true, usage, repairedFiles: [] };

    const ownerRoot = deps.ownerRoot ?? deps.cwd;
    const repairedFiles = new Set<string>();
    progress?.("typecheck");
    let result = await integratedTypecheck(deps);
    let attempt = 0;
    // tsc output from earlier failed repair attempts, so a retry sees what it already couldn't fix.
    const priorOutputs: string[] = [];
    while (!result.ok && attempt < maxRepairs) {
      attempt++;
      // tsc paths are owner-relative; map them (and the dump the model reads) to repo-relative so
      // the editable-file list is correct whether or not this is a monorepo package.
      const { output: repoOutput, files: errorFiles } = remapTscDiagnostics(result.output, deps.cwd, ownerRoot);
      for (const file of errorFiles) if (!unit.files.includes(file)) repairedFiles.add(file);
      const editableFiles = [...new Set([...unit.files, ...errorFiles])];
      progress?.("regression-repair", `integration ${attempt}/${maxRepairs}`);
      const repair = await runSessionWithTimeout(deps, {
        file: unit.file,
        findings: unit.findings,
        model: deps.repairModel,
        prompt: renderIntegrationRepairPrompt({
          unit,
          editableFiles,
          // The repair edits the post-integration tree, so feed it that current content (§12).
          fileContents: contentMapFor(snapshotUnitFiles(deps.cwd, editableFiles), editableFiles),
          gateOutput: repoOutput,
          priorOutputs,
        }),
        onActivity: (detail) => progress?.("regression-repair", detail),
      });
      if (repair.usage) usage = addUsage(usage, repair.usage);
      if (!repair.ok) {
        restoreSnapshot(deps.cwd, beforeFix);
        return {
          kept: false,
          reason: "final-integration-failed",
          detail: `integration repair session failed: ${repair.error}`,
          usage,
          repairedFiles: [...repairedFiles],
        };
      }
      priorOutputs.push(repoOutput); // so the next attempt (if any) sees this dead end
      progress?.("typecheck");
      result = await integratedTypecheck(deps);
    }

    if (result.ok) return { kept: true, usage, repairedFiles: [...repairedFiles] };

    // Repair couldn't reconcile the combined break within the retry budget. Drop just this fix:
    // restore its own files precisely to pre-fix content (the caller reverts repairedFiles too).
    restoreSnapshot(deps.cwd, beforeFix);
    return {
      kept: false,
      reason: "final-integration-failed",
      detail: result.output,
      usage,
      repairedFiles: [...repairedFiles],
    };
  };
}
