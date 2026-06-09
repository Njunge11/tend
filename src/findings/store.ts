import { FindingSchema, type Finding } from "./finding.js";
import { normalizeRevertDetail } from "./revert-detail.js";
import type { FailureClass } from "../session/types.js";
import { z } from "zod";

type RevertReason = NonNullable<Finding["revertReason"]>;

const StoreSchema = z.array(FindingSchema);

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
   *   - known but absent now  → marked `fixed`
   *   - present both loops     → stays as-is, carries attempts/history, bumps lastSeenLoop
   *   - new fingerprint         → added `pending`, firstSeenLoop = loop
   */
  reconcile(fresh: Finding[], loop: number): void {
    const freshIds = new Set(fresh.map((f) => f.id));

    // Intentionally NOT scoped by `inFixScope`: a finding absent from a fresh scan is genuinely
    // gone, and that reflects the repo's actual state (a removed secret, a clone the user deleted),
    // not tend taking credit. Skipping `inFixScope === false` here would wrongly leave genuinely
    // resolved out-of-scope findings (e.g. a secret the user removed) reported as still unresolved.
    // The report-only-leak bug is closed upstream by `dispatchableUnits` filtering plans before
    // unit-building, so tend no longer edits out-of-scope files and this no longer mis-fires.
    for (const known of this.findings.values()) {
      if (!freshIds.has(known.id)) {
        known.status = "fixed";
        delete known.revertReason;
        delete known.revertDetail;
        delete known.finalFailureClass;
      }
    }

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
