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
