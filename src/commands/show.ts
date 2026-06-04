import type { Finding } from "../findings/finding.js";
import { resolveFindingId } from "./resolve-finding.js";

/** `tend show <id>` — full detail on one finding: attempts, revert reason, taint flow path. */
export function showCommand(id: string, findings: Finding[]): string {
  const resolved = resolveFindingId(id, findings);
  if ("error" in resolved) return resolved.error;

  const finding = resolved;
  const lines = [
    `${finding.tool}  ${finding.rule}  [${finding.status}]`,
    `retry id: ${finding.retryId ?? "(none)"}`,
    `fingerprint: ${finding.id}`,
    `${finding.file}:${finding.range.startLine}`,
    finding.message,
    `attempts: ${finding.attempts}`,
  ];
  if (finding.revertReason) lines.push(`last revert reason: ${finding.revertReason}`);
  if (finding.revertDetail) lines.push(`last revert detail: ${finding.revertDetail}`);
  if (finding.flowPath?.length) {
    lines.push("flow path:");
    for (const step of finding.flowPath) lines.push(`  → ${step.file}:${step.line}`);
  }
  if (finding.helpUri) lines.push(`docs: ${finding.helpUri}`);

  return lines.join("\n");
}
