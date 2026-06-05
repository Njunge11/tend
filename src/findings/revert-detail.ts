const MAX_REVERT_DETAIL_LENGTH = 500;

/** Keep persisted diagnostics readable and bounded for report.json. */
export function normalizeRevertDetail(detail: string | undefined): string | undefined {
  const trimmed = detail
    ?.replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .join("\n")
    .trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= MAX_REVERT_DETAIL_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_REVERT_DETAIL_LENGTH - 3)}...`;
}
