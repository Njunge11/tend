import { customAlphabet } from "nanoid";
import type { Finding } from "../findings/finding.js";

const RETRY_ID_LENGTH = 6;
const RETRY_ID_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";

const makeRetryId = customAlphabet(RETRY_ID_ALPHABET, RETRY_ID_LENGTH);

export type RetryIdGenerator = () => string;

function hasUsableRetryId(finding: Finding): finding is Finding & { retryId: string } {
  return typeof finding.retryId === "string" && finding.retryId.length > 0;
}

function nextUniqueRetryId(used: Set<string>, generate: RetryIdGenerator): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const retryId = generate();
    if (!used.has(retryId)) return retryId;
  }
  throw new Error("Could not generate a unique retry id");
}

/** Ensure every finding in a persisted report has a human-facing id unique to that report. */
export function assignRetryIds(
  findings: Finding[],
  generate: RetryIdGenerator = makeRetryId,
): Finding[] {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    if (!hasUsableRetryId(finding)) continue;
    counts.set(finding.retryId, (counts.get(finding.retryId) ?? 0) + 1);
  }

  const used = new Set<string>();
  return findings.map((finding) => {
    if (hasUsableRetryId(finding) && counts.get(finding.retryId) === 1) {
      used.add(finding.retryId);
      return finding;
    }

    const retryId = nextUniqueRetryId(used, generate);
    used.add(retryId);
    return { ...finding, retryId };
  });
}
