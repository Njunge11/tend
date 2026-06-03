import { normalize, type RawFinding } from "../findings/normalize.js";
import type { Finding, Tool } from "../findings/finding.js";

export type ScanContext = {
  cwd: string;
  /** Files in scope (e.g. changed vs HEAD); a scanner may ignore this if it scans wide. */
  files: string[];
  loop: number;
};

export type SpawnResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

/** Runs a binary, never throwing on non-zero exit (parse decides), but may throw on timeout/ENOENT. */
export type Spawn = (
  binary: string,
  args: string[],
  opts: { cwd: string; timeout?: number },
) => Promise<SpawnResult>;

/** Resolves whether a binary is on PATH. */
export type Which = (binary: string) => Promise<boolean>;

export interface Scanner {
  readonly tool: Tool;
  readonly binary: string;
  buildArgs(ctx: ScanContext): string[];
  /** Parse raw process output into findings. Throws on malformed output. */
  parse(raw: SpawnResult, ctx: ScanContext): RawFinding[];
}

export type ScanResult = {
  tool: Tool;
  findings: Finding[];
  skipped: boolean;
  error?: string;
};

/** Outcome of a scanner this loop, for the report's scanner-status line. */
export type ScannerStatusKind = "ran" | "skipped" | "failed";
export type ScannerStatus = { tool: Tool; status: ScannerStatusKind; reason?: string };

/** Collapse a ScanResult to its reportable status: skipped → ran → failed (error present). */
export function scannerStatus(result: ScanResult): ScannerStatus {
  if (result.skipped) return { tool: result.tool, status: "skipped" };
  if (result.error !== undefined) return { tool: result.tool, status: "failed", reason: result.error };
  return { tool: result.tool, status: "ran" };
}

export async function isAvailable(scanner: Scanner, which: Which): Promise<boolean> {
  return which(scanner.binary);
}

/**
 * Shared run sequence for every scanner:
 *   availability → args → spawn → parse → normalize.
 * Missing binary → skipped (not fatal). Timeout/spawn error or malformed output → error result.
 */
export async function runScanner(
  scanner: Scanner,
  ctx: ScanContext,
  deps: { which: Which; spawn: Spawn; timeout?: number },
): Promise<ScanResult> {
  if (!(await isAvailable(scanner, deps.which))) {
    return { tool: scanner.tool, findings: [], skipped: true };
  }

  const args = scanner.buildArgs(ctx);

  let raw: SpawnResult;
  try {
    raw = await deps.spawn(scanner.binary, args, { cwd: ctx.cwd, timeout: deps.timeout });
  } catch (err) {
    return { tool: scanner.tool, findings: [], skipped: false, error: errorMessage(err) };
  }

  try {
    const findings = scanner.parse(raw, ctx).map((r) => normalize(r, ctx.loop));
    return { tool: scanner.tool, findings, skipped: false };
  } catch (err) {
    // Output we couldn't parse. If the scanner also exited non-zero it genuinely failed
    // (e.g. crashed loading a config and printed a non-JSON banner) — its stderr is the
    // useful reason for the human, not the JSON.parse exception. A clean (zero) exit that
    // still fails to parse is a malformed-output bug, so keep the parse error there.
    const reason = raw.exitCode !== 0 ? raw.stderr.trim() || errorMessage(err) : errorMessage(err);
    return { tool: scanner.tool, findings: [], skipped: false, error: reason };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
