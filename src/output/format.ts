import type { AuditExclusions } from "./events.js";

/**
 * The audit line's funnel suffix: " → 2 eligible to fix (8 in test files, 1 excluded from
 * fix scope)". Zero-count reasons are omitted; empty string when eligibility is unknown
 * (events from older emitters). Shared by the live and plain reporters so both views explain
 * the in-scope → dispatched collapse identically.
 */
export function formatAuditFunnel(
  eligible: number | undefined,
  excluded: AuditExclusions | undefined,
  arrow: string,
): string {
  if (eligible === undefined) return "";
  const reasons = excluded
    ? (
        [
          [excluded.tests, "in test files"],
          [excluded.generated, "generated"],
          [excluded.fixtures, "fixtures"],
          [excluded.reportOnly, "report-only"],
          [excluded.outOfScope, "excluded from fix scope"],
        ] as const
      )
        .filter(([count]) => count > 0)
        .map(([count, label]) => `${count} ${label}`)
    : [];
  const parenthetical = reasons.length > 0 ? ` (${reasons.join(", ")})` : "";
  return ` ${arrow} ${eligible} eligible to fix${parenthetical}`;
}

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
    case "sandbox-setup-failed":
      return "sandbox setup failed";
    case "patch-conflict":
      return "patch conflict";
    case "unowned-patch":
      return "unowned patch";
    case "final-integration-failed":
      return "final integration failed";
    case "needs-lockfile-update":
      return "needs lockfile update";
    default:
      return "couldn't fix";
  }
}
