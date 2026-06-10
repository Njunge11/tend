import type { Finding, Tool } from "../findings/finding.js";
import type { AuditResult } from "../orchestrator.js";
import type { EventBus } from "../output/events.js";
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
const SPAWN_SCANNERS: Scanner[] = [
  knipScanner,
  jscpdScanner,
  semgrepScanner,
  osvScanner,
  gitleaksScanner,
];

/** Bundled scanners that do not require an external binary on PATH. */
const BUNDLED_SCANNERS = ["sonarjs"];

/** External scanner binary names, for the preflight availability hint. */
const EXTERNAL_SCANNER_BINARIES = SPAWN_SCANNERS.map(
  (scanner) => scanner.binary,
);

type AuditDeps = {
  cwd: string;
  which: Which;
  spawn: Spawn;
  /**
   * Files the diff-aware scanners (eslint+sonarjs, semgrep) target this run. `null` scans
   * the whole repo (the `--all` backlog). The caller resolves this list once — from changed
   * files, explicit path arguments, or `null` for `--all` — rather than re-deriving it here.
   */
  scope: string[] | null;
  timeoutMs?: number;
  bus?: EventBus;
  tools?: Tool[];
};

type ScanFilesDeps = {
  cwd: string;
  which: Which;
  spawn: Spawn;
  timeoutMs?: number;
  bus?: EventBus;
  tools?: Tool[];
};

let scanCounter = 0;

async function runScanners(
  deps: ScanFilesDeps,
  files: string[],
  loop: number,
): Promise<{
  results: ScanResult[];
  scannerStatuses: ScannerStatus[];
}> {
  const ctx = { cwd: deps.cwd, files, loop, scanId: `${process.pid}-${loop}-${scanCounter++}` };
  const requested = deps.tools ? new Set<Tool>(deps.tools) : undefined;
  const shouldRun = (tool: Tool): boolean => requested === undefined || requested.has(tool);
  const runWithEvents = async (scanner: Scanner): Promise<ScanResult> => {
    deps.bus?.emit({ type: "scanner-start", loop, tool: scanner.tool });
    const result = await runScanner(scanner, ctx, {
      which: deps.which,
      spawn: deps.spawn,
      timeout: deps.timeoutMs,
    });
    const status = scannerStatus(result);
    deps.bus?.emit({
      type: "scanner-result",
      loop,
      tool: scanner.tool,
      status: status.status,
      findings: result.findings.length,
      reason: status.reason,
    });
    return result;
  };

  const spawnedPromise = Promise.all(SPAWN_SCANNERS.filter((scanner) => shouldRun(scanner.tool)).map(runWithEvents));
  // eslint+sonarjs is bundled → always runs (via the Node API), never "missing"
  const eslintPromise = shouldRun("sonarjs")
    ? (async () => {
        deps.bus?.emit({ type: "scanner-start", loop, tool: "sonarjs" });
        const result = await runEslintSonarjs(ctx);
        const status = scannerStatus(result);
        deps.bus?.emit({
          type: "scanner-result",
          loop,
          tool: "sonarjs",
          status: status.status,
          findings: result.findings.length,
          reason: status.reason,
        });
        return result;
      })()
    : Promise.resolve(undefined);
  const [spawned, eslint] = await Promise.all([spawnedPromise, eslintPromise]);
  const results = eslint ? [...spawned, eslint] : spawned;

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
): (loop: number, tools?: Tool[]) => Promise<AuditResult> {
  return async (loop, tools) => {
    // An explicitly-empty scope means "scan nothing" — never fall through to the
    // scanner-specific whole-repo defaults (eslint/semgrep treat no paths as scan-everything).
    if (deps.scope !== null && deps.scope.length === 0) {
      return { findings: [], allScannersMissing: false, scanned: 0, scannerStatuses: [] };
    }
    const files = deps.scope ?? ["."];
    const scanDeps = tools ? { ...deps, tools } : deps;
    const { results, scannerStatuses } = await runScanners(scanDeps, files, loop);

    const attempted = results.filter((r) => !r.skipped);
    const findings: Finding[] = results.flatMap((r) => r.findings);

    // Resolved fix-scope file count. Some scanners still scan wide for correctness, so this
    // is a scope label for the renderer, not a promise that every scanner only read these files.
    const scanned = deps.scope ? deps.scope.length : undefined;

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
