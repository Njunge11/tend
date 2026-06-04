import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "../findings/finding.js";
import { antiRegression } from "../gate/checks/anti-regression.js";
import { antiSuppression } from "../gate/checks/anti-suppression.js";
import { typecheck } from "../gate/checks/typecheck.js";
import { runTestPhase, type TestOutcome } from "../gate/checks/tests.js";
import type { FixOutcome } from "../orchestrator.js";
import { addUsage, zeroUsage, type SessionRunner } from "../session/types.js";
import type { WorkUnit } from "./dispatch.js";

export type FixUnitDeps = {
  cwd: string;
  session: SessionRunner;
  typescript: boolean;
  runTsc: () => Promise<{ exitCode: number; output: string }>;
  hasTestRunner: boolean;
  runRelated: (files: string[]) => Promise<TestOutcome[]>;
  scanFindings: (files: string[]) => Promise<Finding[]>;
  baseline: Set<string>;
  maxRepairs: number;
};

/** Render the fix prompt for a unit's findings. */
function renderPrompt(unit: WorkUnit): string {
  const lines = unit.findings.map(
    (f: Finding) => `- ${f.file}:${f.range.startLine} [${f.tool}/${f.rule}] ${f.message}`,
  );
  return [
    `Fix the following findings in ${unit.file} (and its sibling test only).`,
    "Fix the underlying issue — never suppress, cast to any, or delete code to silence a scanner.",
    "Emit the full corrected file contents with the Write tool.",
    "",
    "Findings:",
    ...lines,
  ].join("\n");
}

/** Build a minimal unified diff from captured before/after contents. */
function buildDiff(before: Map<string, string | null>, after: Map<string, string | null>): string {
  const out: string[] = [];
  for (const [path, afterContent] of after) {
    const beforeLines = (before.get(path) ?? "").split("\n");
    const afterLines = (afterContent ?? "").split("\n");
    for (const l of beforeLines) if (!afterLines.includes(l)) out.push(`-${l}`);
    for (const l of afterLines) if (!beforeLines.includes(l)) out.push(`+${l}`);
  }
  return out.join("\n");
}

/** A file's current contents, or null if it doesn't exist. */
const snapshotFile = (abs: string): string | null => (existsSync(abs) ? readFileSync(abs, "utf8") : null);

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
  return async (unit: WorkUnit): Promise<FixOutcome> => {
    const abs = (f: string) => join(deps.cwd, f);
    const before = new Map(unit.files.map((f) => [f, snapshotFile(abs(f))] as const));

    const restore = (): void => {
      for (const [f, original] of before) {
        const p = abs(f);
        if (original === null) {
          if (existsSync(p)) rmSync(p, { force: true });
        } else {
          writeFileSync(p, original);
        }
      }
    };
    const diskNow = () => new Map(unit.files.map((f) => [f, snapshotFile(abs(f))] as const));
    const changedOnDisk = () => unit.files.some((f) => snapshotFile(abs(f)) !== before.get(f));

    // Estimated AI cost/usage accumulates across the initial session and any repair
    // sessions — even when the unit ends up reverted or unfixable, the tokens were spent.
    let usage = zeroUsage();

    const res = await deps.session.run({ file: unit.file, findings: unit.findings, prompt: renderPrompt(unit) });
    if (res.usage) usage = addUsage(usage, res.usage);

    // Files changed but the session errored/crashed → never leave a half-applied edit
    // for the re-scan to call "fixed"; revert to the snapshot.
    if (!res.ok) {
      if (changedOnDisk()) restore();
      return { kept: false, reason: "session-error", detail: res.error, usage };
    }

    // The session left the files untouched → nothing to gate or revert.
    if (!changedOnDisk()) {
      return {
        kept: false,
        reason: "session-error",
        detail: "Session completed without changing owned files",
        usage,
      };
    }

    const supp = antiSuppression(buildDiff(before, diskNow()));
    if (!supp.ok) {
      restore();
      return { kept: false, reason: supp.reason, detail: supp.detail, usage };
    }

    const tc = await typecheck({ hasTsconfig: () => deps.typescript, runTsc: deps.runTsc });
    if (!tc.ok) {
      restore();
      return { kept: false, reason: tc.reason, detail: tc.detail, usage };
    }

    let repairFailureDetail: string | undefined;
    const phase = await runTestPhase({
      baseline: deps.baseline,
      runRelated: () => deps.runRelated(unit.files),
      // The repair session also edits the disk directly — just re-run it.
      repair: async () => {
        const repair = await deps.session.run({
          file: unit.file,
          findings: unit.findings,
          prompt: `${renderPrompt(unit)}\n\nThe previous edit left a test red — diagnose and fix.`,
        });
        if (repair.usage) usage = addUsage(usage, repair.usage);
        if (!repair.ok) repairFailureDetail = `Repair session failed: ${repair.error}`;
      },
      maxRepairs: deps.maxRepairs,
      hasTestRunner: deps.hasTestRunner,
    });
    if (!phase.ok) {
      restore();
      return { kept: false, reason: phase.reason, detail: repairFailureDetail ?? phase.detail, usage };
    }

    const afterFindings = await deps.scanFindings(unit.files);
    const regression = antiRegression(unit.findings, afterFindings);
    if (!regression.ok) {
      restore();
      return { kept: false, reason: regression.reason, detail: regression.detail, usage };
    }

    return { kept: true, usage };
  };
}
