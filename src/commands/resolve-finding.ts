import type { Finding } from "../findings/finding.js";

export type FindingResolution = Finding | { error: string };

function displayId(finding: Finding): string {
  return finding.retryId ?? finding.id;
}

export function resolveFindingId(id: string, findings: Finding[]): FindingResolution {
  const retryMatch = findings.find((f) => f.retryId === id);
  if (retryMatch) return retryMatch;

  const exact = findings.find((f) => f.id === id);
  if (exact) return exact;

  const prefixMatches = findings.filter((f) => f.id.startsWith(id));
  if (prefixMatches.length === 0) return { error: `No finding with id "${id}"` };
  if (prefixMatches.length > 1) {
    const matches = prefixMatches.map(displayId).join(", ");
    return {
      error: `Finding id "${id}" is ambiguous; matches ${matches}. Use the retry id or full fingerprint.`,
    };
  }
  return prefixMatches[0]!;
}
