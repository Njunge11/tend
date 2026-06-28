import { pass, reject, type CheckResult } from "../check.js";

type TypecheckDeps = {
  /** Whether the project has a tsconfig (TS mode). */
  hasTsconfig: () => boolean | Promise<boolean>;
  /** Run `tsc --noEmit` and return its exit code + combined output. */
  runTsc: () => Promise<{ exitCode: number; output: string }>;
  /**
   * Normalized signatures of tsc errors that already existed on the pristine tree, captured
   * once before any fix (see {@link parseTscErrors}). A fix is rejected only for errors that
   * are NOT in this baseline, so a pre-existing error elsewhere in the owning package's program
   * (e.g. a broken test fixture in a file the fix never touched) can't false-revert a clean fix.
   *
   * `undefined` means no baseline was captured (capture disabled or failed) → fail closed: any
   * tsc error rejects, preserving the original strict behavior.
   */
  baselineErrors?: readonly string[];
};

// A tsc diagnostic line: "path(line,col): error TSxxxx: message". Pretty output is off when tsc
// runs without a TTY (as the gate spawns it), so this plain single-line format is what we parse.
const TSC_ERROR_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

/**
 * Parse `tsc --noEmit` output into one normalized signature per error. The signature is
 * `file|code|message` — deliberately WITHOUT the line/column, so an edit that shifts line
 * numbers doesn't make a pre-existing error look new. Duplicates are kept so the baseline
 * comparison is a multiset: a fix that adds a SECOND copy of an already-present error is
 * still caught.
 */
export function parseTscErrors(output: string): string[] {
  const sigs: string[] = [];
  for (const line of output.split("\n")) {
    const m = TSC_ERROR_LINE.exec(line.trim());
    if (m) sigs.push(`${m[1]}|${m[4]}|${m[5]}`);
  }
  return sigs;
}

/** Multiset difference: the signatures in `after` not covered, by count, by `baseline`. */
function newErrors(after: readonly string[], baseline: readonly string[]): string[] {
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
 * Reject a fix that introduces a NEW `tsc --noEmit` error. Skipped (pass) when there's no
 * tsconfig. Errors that already existed on the pristine tree (the {@link TypecheckDeps.baselineErrors}
 * baseline) are ignored, so a fix is only blamed for breakage it actually caused.
 */
export async function typecheck(deps: TypecheckDeps): Promise<CheckResult> {
  if (!(await deps.hasTsconfig())) return pass();

  const { exitCode, output } = await deps.runTsc();
  if (exitCode === 0) return pass();

  // No baseline captured → fail closed on any error (original strict behavior).
  if (deps.baselineErrors === undefined) {
    return reject("typecheck", output.trim() || "tsc --noEmit failed");
  }

  const after = parseTscErrors(output);
  // tsc failed but emitted no parseable diagnostics — a crash, timeout, or unexpected format.
  // Never silently pass that; fail closed on the raw output.
  if (after.length === 0) {
    return reject("typecheck", output.trim() || "tsc --noEmit failed");
  }

  const fresh = newErrors(after, deps.baselineErrors);
  // tsc failed, but every error pre-existed the fix → the fix didn't break typecheck.
  if (fresh.length === 0) return pass();
  return reject("typecheck", fresh.join("\n"));
}
