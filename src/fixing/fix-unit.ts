import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Finding, Tool } from "../findings/finding.js";
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
  /** Hard cap for a gate pass. Individual subprocesses also have their own timeouts. */
  gateTimeoutMs?: number;
};

const DEFAULT_SESSION_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_GATE_TIMEOUT_MS = 30 * 60_000;

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

function replaceAllLiteral(input: string, search: string, replacement: string): string {
  return input.split(search).join(replacement);
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
  rejectedDiff: string;
  newFindings: Finding[];
  gateReason: string;
  gateOutput: string;
}): string {
  const strategyName = "regression-repair";
  const prompt = renderCommonTemplate({
    template: REGRESSION_REPAIR_PROMPT_TEMPLATE,
    strategyName,
    findings: renderFindingsJson(input.unit.findings),
    editableFiles: input.unit.files,
    verificationTargets: input.unit.verificationTargets ?? input.unit.files,
  });
  return replaceAllLiteral(
    replaceAllLiteral(
      replaceAllLiteral(
        prompt,
        "{{rejectedDiff}}",
        firstRelevantLines(input.rejectedDiff, 80),
      ),
      "{{newFindings}}",
      renderFindingsJson(input.newFindings),
    ),
    "{{gateDetails}}",
    [`Reason: ${input.gateReason}`, firstRelevantLines(input.gateOutput)].join("\n"),
  ).trim();
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
  const run = deps.session
    .run({ ...request, signal: controller.signal })
    .catch((error): SessionResult => ({
      ok: false,
      error: errorMessage(error),
      rateLimited: false,
      failureClass: controller.signal.aborted ? "tool-timeout" : "model-tool-failure",
      usage: zeroUsage(),
    }));

  if (!timeoutEnabled(timeoutMs)) return run;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<SessionResult>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve({
        ok: false,
        error: `AI session timed out after ${formatDuration(timeoutMs)}`,
        rateLimited: false,
        failureClass: "tool-timeout",
        usage: zeroUsage(),
      });
    }, timeoutMs);
  });

  try {
    return await Promise.race([run, timedOut]);
  } finally {
    if (timeout) clearTimeout(timeout);
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

    // Sessions stream activity while they run; surface it as detail on the live stage so
    // long AI edits show ongoing progress instead of a single static label.
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
      return {
        kept: false,
        reason: "session-error",
        detail: res.error,
        failureClass: res.failureClass,
        usage,
      };
    }

    // No-edit sessions get one stricter retry — unless the unit is mechanical (dead-code,
    // autofixable), where a second attempt won't help and just wastes time.
    if (!changedOnDisk()) {
      if (isMechanicalUnit(unit)) {
        return {
          kept: false,
          reason: "session-error",
          detail: "Mechanical fix session completed without edits",
          failureClass: "no-op",
          usage,
        };
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
        return {
          kept: false,
          reason: "session-error",
          detail: retry.error,
          failureClass: retry.failureClass,
          usage,
        };
      }
      if (changedOnDisk()) {
        // Continue into the normal gate with the stricter retry's edit.
      } else {
        return {
          kept: false,
          reason: "session-error",
          detail: "Session completed without changing owned files after stricter retry",
          failureClass: "no-op",
          usage,
        };
      }
    }

    async function scanNewFindings(): Promise<Finding[]> {
      progress("rescan");
      const afterFindings = await deps.scanFindings(verificationTargets, scannerTools);
      // Genuinely new findings only — exclude anything that already existed in this scope.
      return afterFindings.filter((f) => !preexistingIds.has(f.id));
    }

    async function runRegressionRepair(outcome: FixOutcome): Promise<boolean> {
      if (outcome.reason !== "regression" && outcome.reason !== "typecheck") return false;
      const after = snapshotUnitNow(deps.cwd, snapshotFiles);
      progress("regression-repair");
      const repair = await runSessionWithTimeout(deps, {
        file: unit.file,
        findings: unit.findings,
        prompt: renderRegressionRepairPrompt({
          unit,
          rejectedDiff: buildDiff(before, after),
          newFindings: outcome.reason === "regression" ? await scanNewFindings() : [],
          gateReason: outcome.reason,
          gateOutput: outcome.detail ?? "",
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
      const after = snapshotUnitNow(deps.cwd, snapshotFiles);
      const repair = await runSessionWithTimeout(deps, {
        file: unit.file,
        findings: unit.findings,
        prompt: renderRegressionRepairPrompt({
          unit,
          rejectedDiff: buildDiff(before, after),
          newFindings: [],
          gateReason: "broke-test",
          gateOutput: `Fix left previously-green test(s) red:\n${regressed.map((test) => test.name).join("\n")}`,
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
      };
    }

    return { ...outcome, usage };
  };
}
