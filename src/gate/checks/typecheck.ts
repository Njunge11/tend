import { pass, reject, type CheckResult } from "../check.js";

export type TypecheckDeps = {
  /** Whether the project has a tsconfig (TS mode). */
  hasTsconfig: () => boolean | Promise<boolean>;
  /** Run `tsc --noEmit` and return its exit code + combined output. */
  runTsc: () => Promise<{ exitCode: number; output: string }>;
};

/** Reject a fix that breaks `tsc --noEmit`. Skipped (pass) when there's no tsconfig. */
export async function typecheck(deps: TypecheckDeps): Promise<CheckResult> {
  if (!(await deps.hasTsconfig())) return pass();

  const { exitCode, output } = await deps.runTsc();
  if (exitCode === 0) return pass();

  return reject("typecheck", output.trim() || "tsc --noEmit failed");
}
