import { describe, expect, it } from "vitest";
import { makeFinding } from "../../test/helpers/make-finding.js";
import { FindingSchema } from "./finding.js";
import { FindingStore } from "./store.js";
import { z } from "zod";

describe("FindingStore", () => {
  it("T-006: add findings → retrievable by id", () => {
    const store = new FindingStore();
    const f = makeFinding({ file: "src/a.ts" });

    store.add(f);

    expect(store.get(f.id)).toStrictEqual(f);
  });

  it("T-007: adding same fingerprint twice → one entry (dedupe)", () => {
    const store = new FindingStore();
    const f = makeFinding({ file: "src/a.ts" });

    store.add(f);
    store.add({ ...f });

    expect(store.all()).toHaveLength(1);
  });

  it("T-008: finding present last loop, absent now → marked fixed", () => {
    const store = new FindingStore();
    const a = makeFinding({ file: "src/a.ts" }, 1);
    const b = makeFinding({ file: "src/b.ts" }, 1);
    store.add(a);
    store.add(b);

    // loop 2: only b still reported; a is gone
    store.reconcile([makeFinding({ file: "src/b.ts" }, 2)], 2);

    expect(store.get(a.id)?.status).toBe("fixed");
    expect(store.get(b.id)?.status).toBe("pending");
  });

  it("T-009: present both loops → stays pending, attempts/history carried", () => {
    const store = new FindingStore();
    const a = makeFinding({ file: "src/a.ts" }, 1);
    a.attempts = 2; // two failed fix attempts so far
    store.add(a);

    store.reconcile([makeFinding({ file: "src/a.ts" }, 2)], 2);

    const after = store.get(a.id);
    expect(after?.status).toBe("pending");
    expect(after?.attempts).toBe(2);
    expect(after?.firstSeenLoop).toBe(1);
    expect(after?.lastSeenLoop).toBe(2);
  });

  it("T-010: new fingerprint this loop → added pending, firstSeenLoop set", () => {
    const store = new FindingStore();
    const known = makeFinding({ file: "src/a.ts" }, 1);
    store.add(known);

    const fresh = makeFinding({ file: "src/new.ts" }, 3);
    store.reconcile([known, fresh], 3);

    const added = store.get(fresh.id);
    expect(added?.status).toBe("pending");
    expect(added?.firstSeenLoop).toBe(3);
    expect(added?.lastSeenLoop).toBe(3);
  });

  it("T-011: failed fix increments attempts; budget reports exhausted at N", () => {
    const store = new FindingStore();
    const f = makeFinding({ file: "src/a.ts" }, 1);
    store.add(f);

    store.recordFailedAttempt(f.id, "broke-test");
    expect(store.get(f.id)?.attempts).toBe(1);
    expect(store.get(f.id)?.revertReason).toBe("broke-test");
    expect(store.isBudgetExhausted(f.id, 3)).toBe(false);

    store.recordFailedAttempt(f.id, "broke-test");
    store.recordFailedAttempt(f.id, "broke-test");
    expect(store.get(f.id)?.attempts).toBe(3);
    expect(store.isBudgetExhausted(f.id, 3)).toBe(true);
  });

  it("stores failed attempt detail and clears stale failure diagnostics when fixed", () => {
    const store = new FindingStore();
    const f = makeFinding({ file: "src/a.ts" }, 1);
    store.add(f);

    store.recordFailedAttempt(f.id, "session-error", "spawn failed");
    expect(store.get(f.id)?.revertDetail).toBe("spawn failed");

    store.reconcile([], 2);

    expect(store.get(f.id)?.status).toBe("fixed");
    expect(store.get(f.id)?.revertReason).toBeUndefined();
    expect(store.get(f.id)?.revertDetail).toBeUndefined();
  });

  it("T-012: query by track / status / file", () => {
    const store = new FindingStore();
    const sonar = makeFinding({ tool: "sonarjs", file: "src/a.ts" }, 1);
    const osv = makeFinding(
      { tool: "osv", rule: "CVE-1", category: "vuln-dep", file: "package.json" },
      1,
    );
    store.add(sonar);
    store.add(osv);
    osv.status = "fixed";

    expect(store.query({ track: "ai-fix" })).toStrictEqual([sonar]);
    expect(store.query({ track: "deterministic" })).toStrictEqual([osv]);
    expect(store.query({ file: "src/a.ts" })).toStrictEqual([sonar]);
    expect(store.query({ status: "pending" })).toStrictEqual([sonar]);
    expect(store.query({ status: "fixed" })).toStrictEqual([osv]);
  });

  it("T-013: empty audit → all previously-known reconcile to fixed", () => {
    const store = new FindingStore();
    store.add(makeFinding({ file: "src/a.ts" }, 1));
    store.add(makeFinding({ file: "src/b.ts" }, 1));

    store.reconcile([], 2);

    expect(store.all().every((f) => f.status === "fixed")).toBe(true);
  });

  describe("drift re-matching (fingerprint instability under the run's own edits)", () => {
    const at = (startLine: number) => ({ startLine, startCol: 0, endLine: startLine, endCol: 10 });

    it("re-matches findings shifted across a bucket boundary: no phantom fixed, no ghost findings", () => {
      // The observed self-run scenario: pass 1 keeps one real fix in src/orchestrator.ts,
      // which shifts the file's remaining (reverted) findings by +1 across a 5-line
      // fingerprint bucket boundary (209→210 = bucket 41→42, 384→385 = 76→77).
      const store = new FindingStore();
      const realFix = makeFinding({ file: "src/orchestrator.ts", rule: "no-dupes", range: at(10) }, 1);
      const revertedA = {
        ...makeFinding({ file: "src/orchestrator.ts", rule: "cognitive-complexity", message: "Refactor this function", range: at(209) }, 1),
        status: "reverted" as const,
        revertReason: "regression" as const,
        attempts: 1,
      };
      const revertedB = {
        ...makeFinding({ file: "src/orchestrator.ts", rule: "max-params", message: "Too many parameters", range: at(384) }, 1),
        status: "reverted" as const,
        revertReason: "typecheck" as const,
        attempts: 2,
      };
      store.add(realFix);
      store.add(revertedA);
      store.add(revertedB);

      const shiftedA = makeFinding({ file: "src/orchestrator.ts", rule: "cognitive-complexity", message: "Refactor this function", range: at(210) }, 2);
      const shiftedB = makeFinding({ file: "src/orchestrator.ts", rule: "max-params", message: "Too many parameters", range: at(385) }, 2);
      // Pin the premise: the shift really does change the fingerprint. (Capture the old ids:
      // re-keying mutates the stored records in place.)
      const oldIdA = revertedA.id;
      expect(shiftedA.id).not.toBe(oldIdA);
      expect(shiftedB.id).not.toBe(revertedB.id);

      store.reconcile([shiftedA, shiftedB], 2);

      // Exactly one real fix — the re-fingerprinted findings are NOT phantom-fixed.
      expect(store.all().filter((f) => f.status === "fixed")).toHaveLength(1);
      expect(store.get(realFix.id)?.status).toBe("fixed");
      // And no ghost duplicates entered as brand-new findings.
      expect(store.all()).toHaveLength(3);

      // The drifted findings are the SAME records, re-keyed: history carried, reverted →
      // pending (never fixed), location refreshed.
      const a = store.get(shiftedA.id);
      expect(store.get(oldIdA)).toBeUndefined();
      expect(a?.status).toBe("pending");
      expect(a?.attempts).toBe(1);
      expect(a?.firstSeenLoop).toBe(1);
      expect(a?.lastSeenLoop).toBe(2);
      expect(a?.range.startLine).toBe(210);
      const b = store.get(shiftedB.id);
      expect(b?.status).toBe("pending");
      expect(b?.attempts).toBe(2);
    });

    it("matches one-to-one by line proximity when a file has two identical findings", () => {
      const store = new FindingStore();
      const near = {
        ...makeFinding({ file: "src/a.ts", rule: "no-var", message: "Unexpected var", range: at(8) }, 1),
        attempts: 1,
      };
      const far = {
        ...makeFinding({ file: "src/a.ts", rule: "no-var", message: "Unexpected var", range: at(19) }, 1),
        attempts: 2,
      };
      store.add(near);
      store.add(far);

      // Both shift +4 across bucket boundaries (8→12 = bucket 1→2, 19→23 = 3→4).
      const freshNear = makeFinding({ file: "src/a.ts", rule: "no-var", message: "Unexpected var", range: at(12) }, 2);
      const freshFar = makeFinding({ file: "src/a.ts", rule: "no-var", message: "Unexpected var", range: at(23) }, 2);
      store.reconcile([freshNear, freshFar], 2);

      expect(store.all()).toHaveLength(2);
      expect(store.all().every((f) => f.status === "pending")).toBe(true);
      // Each known claimed its closest counterpart, one-to-one (attempts are the marker).
      expect(store.get(freshNear.id)?.attempts).toBe(1);
      expect(store.get(freshFar.id)?.attempts).toBe(2);
    });

    it("does not re-match beyond the drift tolerance: a distant same-identity finding is new", () => {
      const store = new FindingStore();
      const known = makeFinding({ file: "src/a.ts", rule: "no-var", message: "Unexpected var", range: at(10) }, 1);
      store.add(known);

      // 80 lines away — far beyond any plausible shift from an accepted edit.
      const distant = makeFinding({ file: "src/a.ts", rule: "no-var", message: "Unexpected var", range: at(90) }, 2);
      store.reconcile([distant], 2);

      expect(store.get(known.id)?.status).toBe("fixed"); // genuinely resolved
      const added = store.get(distant.id);
      expect(added?.status).toBe("pending");
      expect(added?.firstSeenLoop).toBe(2);
      expect(store.all()).toHaveLength(2);
    });
  });

  it("T-014: serialize → JSON → deserialize round-trips and is zod-valid", () => {
    const store = new FindingStore();
    store.add(makeFinding({ file: "src/a.ts" }, 1));
    store.add(makeFinding({ file: "src/b.ts" }, 1));

    const serialized = JSON.parse(JSON.stringify(store.toJSON()));

    expect(() => z.array(FindingSchema).parse(serialized)).not.toThrow();

    const restored = FindingStore.fromJSON(serialized);
    expect(restored.all()).toStrictEqual(store.all());
  });
});
