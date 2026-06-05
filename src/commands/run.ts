import { orchestrate, type OrchestrateDeps } from "../orchestrator.js";
import { ReportBuilder } from "../report/builder.js";
import type { Report } from "../report/schema.js";

export type RunDeps = OrchestrateDeps & { now?: () => number };

/** `tend run` — wire audit → fix loop → report. */
export async function runCommand(deps: RunDeps): Promise<{ report: Report; exitStatus: number }> {
  const now = deps.now ?? Date.now;
  const start = now();
  const result = await orchestrate(deps);

  const builder = new ReportBuilder();
  builder.recordOutcomes(result.findings);
  builder.recordScannerStatuses(result.scannerStatuses);

  const report = builder.build({
    loops: result.loops,
    durationMs: now() - start,
    exitStatus: result.exitStatus,
    aiUsage: result.usage,
    runScope: result.runScope,
    fixPolicy: {
      includeTests: Boolean(deps.config.includeTests),
      include: deps.config.fix?.include ?? [],
      exclude: deps.config.fix?.exclude ?? [],
      includeGenerated: Boolean(deps.config.fix?.includeGenerated),
      includeFixtures: Boolean(deps.config.fix?.includeFixtures),
    },
  });

  return { report, exitStatus: result.exitStatus };
}
