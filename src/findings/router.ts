import { TOOLS, type Finding, type Tool } from "./finding.js";
import { trackForTool } from "./normalize.js";

export type RouteResult = {
  aiFix: Finding[];
  deterministic: Finding[];
  reportOnly: Finding[];
  skipped: Finding[];
};

function isKnownTool(tool: string): tool is Tool {
  return (TOOLS as readonly string[]).includes(tool);
}

/** Split findings into fix tracks by tool; unknown tools are skipped with a warning. */
export function route(
  findings: Finding[],
  opts: { warn?: (message: string) => void } = {},
): RouteResult {
  const result: RouteResult = { aiFix: [], deterministic: [], reportOnly: [], skipped: [] };

  for (const finding of findings) {
    if (!isKnownTool(finding.tool)) {
      opts.warn?.(`Skipping finding from unknown tool "${finding.tool}"`);
      result.skipped.push(finding);
      continue;
    }

    switch (trackForTool(finding.tool)) {
      case "ai-fix":
        result.aiFix.push(finding);
        break;
      case "deterministic":
        result.deterministic.push(finding);
        break;
      case "report-only":
        result.reportOnly.push(finding);
        break;
    }
  }

  return result;
}
