import { FindingSchema, normalizedIdentity, type Finding } from "./finding.js";
import { normalizeRevertDetail } from "./revert-detail.js";
import type { FailureClass } from "../session/types.js";
import { z } from "zod";

type RevertReason = NonNullable<Finding["revertReason"]>;

const StoreSchema = z.array(FindingSchema);

/**
 * Max line distance for drift re-matching in reconcile. Accepted edits shift findings by the
 * net lines added/removed above them — small in practice (±1..8 in an observed run). Beyond
 * this, a same-identity fresh finding is more plausibly a different instance than a shifted
 * one, and mislinking it would hide a real fix.
 */
const MAX_LINE_DRIFT = 25;

/** Holds Finding records keyed by fingerprint and tracks their state across loops. */
export class FindingStore {
  private readonly findings = new Map<string, Finding>();

  add(finding: Finding): void {
    this.findings.set(finding.id, finding);
  }

  get(id: string): Finding | undefined {
    return this.findings.get(id);
  }

  all(): Finding[] {
    return [...this.findings.values()];
  }

  /**
   * Diff a fresh audit against what the store knows, by fingerprint:
   *   - known but absent now  → re-matched by drift if a same-identity fresh finding sits
   *     nearby (an accepted edit moved it across a 5-line fingerprint bucket), else `fixed`
   *   - present both loops     → stays as-is, carries attempts/history, bumps lastSeenLoop
   *   - new fingerprint         → added `pending`, firstSeenLoop = loop
   */
  reconcile(fresh: Finding[], loop: number, auditedTools?: ReadonlySet<Finding["tool"]>): void {
    const freshIds = new Set(fresh.map((f) => f.id));
    const unclaimed = this.collectUnclaimed(fresh);
    this.resolveMissing(freshIds, unclaimed, auditedTools);
    this.applyFresh(fresh, loop);
  }

  /**
   * Fresh findings with no exact-fingerprint match, grouped by line-free identity: the
   * candidates a known-but-absent finding may have drifted into.
   */
  private collectUnclaimed(fresh: Finding[]): Map<string, Finding[]> {
    const unclaimed = new Map<string, Finding[]>();
    for (const incoming of fresh) {
      if (this.findings.has(incoming.id)) continue;
      const key = normalizedIdentity(incoming);
      const list = unclaimed.get(key);
      if (list) list.push(incoming);
      else unclaimed.set(key, [incoming]);
    }
    return unclaimed;
  }

  /**
   * Known findings absent from the fresh scan: re-keyed to a drift candidate if one is
   * nearby, otherwise marked `fixed`.
   *
   * Intentionally NOT scoped by `inFixScope`: a finding absent from a fresh scan is genuinely
   * gone, and that reflects the repo's actual state (a removed secret, a clone the user deleted),
   * not tend taking credit. Skipping `inFixScope === false` here would wrongly leave genuinely
   * resolved out-of-scope findings (e.g. a secret the user removed) reported as still unresolved.
   * The report-only-leak bug is closed upstream by `dispatchableUnits` filtering plans before
   * unit-building, so tend no longer edits out-of-scope files and this no longer mis-fires.
   */
  private resolveMissing(
    freshIds: Set<string>,
    unclaimed: Map<string, Finding[]>,
    auditedTools?: ReadonlySet<Finding["tool"]>,
  ): void {
    // When a loop re-audits only a subset of scanners (e.g. it skips knip's whole-repo scan
    // because all knip findings are out of fix scope), a finding from a NON-audited tool being
    // absent doesn't mean it was resolved — that tool simply didn't run. Only reconcile findings
    // whose tool actually ran this loop; leave the rest untouched (their last known state stands).
    const missing = [...this.findings.values()].filter(
      (known) => !freshIds.has(known.id) && (auditedTools === undefined || auditedTools.has(known.tool)),
    );
    // Active records claim drift candidates before already-`fixed` ones, so a stale fixed
    // record with the same identity can't steal the candidate of the genuinely drifted
    // pending finding (which would then be wrongly flipped to fixed).
    missing.sort((a, b) => Number(a.status === "fixed") - Number(b.status === "fixed"));
    for (const known of missing) {
      const drifted = this.claimDriftMatch(known, unclaimed);
      if (drifted) {
        this.rekeyDrifted(known, drifted);
        continue;
      }
      known.status = "fixed";
      delete known.revertReason;
      delete known.revertDetail;
      delete known.finalFailureClass;
    }
  }

  /**
   * Same finding, new position: re-key to the fresh fingerprint and refresh the
   * location-dependent fields. Status/attempts/history are NOT touched here — the
   * claimed fresh id now resolves to this record, so the present-both-loops branch in
   * `applyFresh` applies the usual transitions (reverted → pending, never → fixed).
   */
  private rekeyDrifted(known: Finding, drifted: Finding): void {
    this.findings.delete(known.id);
    known.id = drifted.id;
    known.range = drifted.range;
    known.message = drifted.message;
    if (drifted.flowPath) known.flowPath = drifted.flowPath;
    else delete known.flowPath;
    this.findings.set(known.id, known);
  }

  /** Bump lastSeenLoop on reappearing findings (reverting fixed/reverted ones) and add new ones. */
  private applyFresh(fresh: Finding[], loop: number): void {
    for (const incoming of fresh) {
      const known = this.findings.get(incoming.id);
      if (known) {
        known.lastSeenLoop = loop;
        // it reappeared, so it isn't actually fixed — back to pending (carry attempts/history).
        // a budget-exhausted `unfixable` finding stays unfixable; we don't retry it.
        if (known.status === "fixed" || known.status === "reverted") known.status = "pending";
      } else {
        this.findings.set(incoming.id, { ...incoming, firstSeenLoop: loop, lastSeenLoop: loop });
      }
    }
  }

  /**
   * The nearest unclaimed fresh finding with the same line-free identity within
   * MAX_LINE_DRIFT of `known`, removed from the pool so each fresh finding is claimed at
   * most once (greedy one-to-one — two same-rule/same-message findings in a file each take
   * their closest counterpart). Candidates whose fingerprint is already a store key are
   * skipped: same-bucket duplicates share a fingerprint, and re-keying a second record onto
   * an id an earlier claim now owns would silently overwrite it.
   */
  private claimDriftMatch(
    known: Finding,
    unclaimed: Map<string, Finding[]>,
  ): Finding | undefined {
    const candidates = unclaimed.get(normalizedIdentity(known));
    if (!candidates || candidates.length === 0) return undefined;
    let best: { index: number; distance: number } | undefined;
    for (const [index, candidate] of candidates.entries()) {
      if (this.findings.has(candidate.id)) continue;
      const distance = Math.abs(candidate.range.startLine - known.range.startLine);
      if (distance > MAX_LINE_DRIFT) continue;
      if (!best || distance < best.distance) best = { index, distance };
    }
    if (!best) return undefined;
    return candidates.splice(best.index, 1)[0];
  }

  /** Findings matching every provided filter (track / status / file). */
  query(filter: {
    track?: Finding["track"];
    status?: Finding["status"];
    file?: string;
  }): Finding[] {
    return this.all().filter(
      (f) =>
        (filter.track === undefined || f.track === filter.track) &&
        (filter.status === undefined || f.status === filter.status) &&
        (filter.file === undefined || f.file === filter.file),
    );
  }

  /** Record a failed fix attempt against a finding's fingerprint. */
  recordFailedAttempt(id: string, reason: RevertReason, detail?: string, failureClass?: FailureClass): void {
    const finding = this.findings.get(id);
    if (!finding) return;
    finding.attempts += 1;
    finding.revertReason = reason;
    if (failureClass) finding.finalFailureClass = failureClass;
    const normalizedDetail = normalizeRevertDetail(detail);
    if (normalizedDetail) finding.revertDetail = normalizedDetail;
    else delete finding.revertDetail;
  }

  recordFailureWithoutAttempt(
    id: string,
    reason: RevertReason,
    detail: string | undefined,
    failureClass: FailureClass,
  ): void {
    const finding = this.findings.get(id);
    if (!finding) return;
    finding.revertReason = reason;
    finding.finalFailureClass = failureClass;
    const normalizedDetail = normalizeRevertDetail(detail);
    if (normalizedDetail) finding.revertDetail = normalizedDetail;
    else delete finding.revertDetail;
  }

  /** A finding's per-issue budget is exhausted once it has used `budget` attempts. */
  isBudgetExhausted(id: string, budget: number): boolean {
    const finding = this.findings.get(id);
    if (!finding) return false;
    return finding.attempts >= budget;
  }

  /** Serialize to a plain array — `report.json`'s findings section. */
  toJSON(): Finding[] {
    return this.all();
  }

  /** Rebuild a store from serialized findings, validating each against the schema. */
  static fromJSON(data: unknown): FindingStore {
    const findings = StoreSchema.parse(data);
    const store = new FindingStore();
    for (const finding of findings) store.add(finding);
    return store;
  }
}
