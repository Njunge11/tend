
/**
 * Human duration for the summary: sub-minute reads as "2.4s", longer as "3m 12s".
 * Deterministic — no locale, no rounding surprises.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  // Carry a rounded-up 60s into the minute so we never print "3m 60s".
  if (seconds === 60) return `${minutes + 1}m 0s`;
  return `${minutes}m ${seconds}s`;
}

/** Stopwatch form for the live per-file timer: "0:42", "1:05". */
export function formatClock(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Plain-language reason a fix was reverted — the most useful thing for a human. */
export function reasonLabel(reason: string | undefined): string {
  switch (reason) {
    case "broke-test":
      return "broke tests";
    case "typecheck":
      return "broke typecheck";
    case "suppression":
      return "added a suppression";
    case "regression":
      return "introduced a new issue";
    case "session-error":
      return "the fix session failed";
    case "needs-lockfile-update":
      return "needs lockfile update";
    default:
      return "couldn't fix";
  }
}
