import type { SimpleGit } from "simple-git";
import type { Finding } from "../findings/finding.js";
import { changedVsHead } from "../git/repo.js";
import type { AuditResult } from "../orchestrator.js";
import { filterToChanged } from "./scope.js";
import { runEslintSonarjs } from "./eslint-sonarjs.js";
import { gitleaksScanner } from "./gitleaks.js";
import { jscpdScanner } from "./jscpd.js";
import { knipScanner } from "./knip.js";
import { osvScanner } from "./osv.js";
import {
  runScanner,
  scannerStatus,
  type ScanResult,
  type Scanner,
  type ScannerStatus,
  type Spawn,
  type Which,
} from "./scanner.js";
import { semgrepScanner } from "./semgrep.js";

/** Spawn-based scanners. eslint+sonarjs runs separately via the Node API (see runEslintSonarjs). */
export const SPAWN_SCANNERS: Scanner[] = [
  knipScanner,
  jscpdScanner,
  semgrepScanner,
  osvScanner,
  gitleaksScanner,
];

/** Bundled scanners that do not require an external binary on PATH. */
export const BUNDLED_SCANNERS = ["sonarjs"];

/** External scanner binary names, for the preflight availability hint. */
export const EXTERNAL_SCANNER_BINARIES = SPAWN_SCANNERS.map(
  (scanner) => scanner.binary,
);

export type AuditDeps = {
  cwd: string;
  git: SimpleGit;
  which: Which;
  spawn: Spawn;
  /** Fix the whole backlog rather than just changed files. */
  all: boolean;
  timeoutMs?: number;
};

export type ScanFilesDeps = {
  cwd: string;
  which: Which;
  spawn: Spawn;
  timeoutMs?: number;
};

async function runScanners(
  deps: ScanFilesDeps,
  files: string[],
  loop: number,
): Promise<{
  results: ScanResult[];
  scannerStatuses: ScannerStatus[];
}> {
  const ctx = { cwd: deps.cwd, files, loop };

  const spawned = await Promise.all(
    SPAWN_SCANNERS.map((scanner) =>
      runScanner(scanner, ctx, {
        which: deps.which,
        spawn: deps.spawn,
        timeout: deps.timeoutMs,
      }),
    ),
  );
  // eslint+sonarjs is bundled → always runs (via the Node API), never "missing"
  const eslint = await runEslintSonarjs(ctx);
  const results = [...spawned, eslint];

  return {
    results,
    scannerStatuses: results.map(scannerStatus),
  };
}

/** Re-scan an explicit file scope and discard findings outside that affected scope. */
export async function scanFiles(
  deps: ScanFilesDeps,
  files: string[],
  loop: number,
): Promise<AuditResult> {
  const { results, scannerStatuses } = await runScanners(deps, files, loop);
  const findings = results.flatMap((r) => r.findings);
  const scoped = files.includes(".") ? findings : filterToChanged(findings, files);
  const attempted = results.filter((r) => !r.skipped);

  return {
    findings: scoped,
    allScannersMissing: attempted.length === 0,
    scanned: files.includes(".") ? undefined : files.length,
    scannerStatuses,
  };
}

/** Assemble the six scanners into an audit function for the orchestrator. */
export function buildAudit(
  deps: AuditDeps,
): (loop: number) => Promise<AuditResult> {
  return async (loop) => {
    const changed = await changedVsHead(deps.git);
    const files = deps.all ? ["."] : changed;
    const { results, scannerStatuses } = await runScanners(deps, files, loop);

    const attempted = results.filter((r) => !r.skipped);
    const findings: Finding[] = results.flatMap((r) => r.findings);

    // Files the scanners looked at this loop. Known precisely for the changed-file path
    // (`--all` scans the whole tree, so leave it for the renderer to phrase generically).
    const scanned = deps.all ? undefined : changed.length;

    return {
      findings,
      allScannersMissing: attempted.length === 0,
      scanned,
      scannerStatuses,
    };
  };
}

/** Tools available vs missing, for the preflight install hint. Bundled sonarjs is always available. */
export async function scannerAvailability(
  which: Which,
): Promise<{ available: string[]; missing: string[] }> {
  const available: string[] = [...BUNDLED_SCANNERS];
  const missing: string[] = [];
  for (const binary of EXTERNAL_SCANNER_BINARIES) {
    if (await which(binary)) available.push(binary);
    else missing.push(binary);
  }
  return { available, missing };
}
