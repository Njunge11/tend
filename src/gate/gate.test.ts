import { describe, expect, it } from "vitest";
import { pass, reject } from "./check.js";
import { runGate, type Check } from "./gate.js";

describe("runGate", () => {
  it("T-062: runs checks in defined order", async () => {
    const order: string[] = [];
    const mk = (name: string): Check => ({
      name,
      run: async () => {
        order.push(name);
        return pass();
      },
    });

    await runGate([mk("anti-suppression"), mk("anti-regression"), mk("typecheck"), mk("tests")]);

    expect(order).toStrictEqual(["anti-suppression", "anti-regression", "typecheck", "tests"]);
  });

  it("T-063: all checks pass → keep", async () => {
    const checks: Check[] = [
      { name: "a", run: async () => pass() },
      { name: "b", run: async () => pass() },
    ];
    expect(await runGate(checks)).toStrictEqual({ kept: true });
  });

  it("T-064: stops on first failing check and returns its revertReason", async () => {
    const ran: string[] = [];
    const checks: Check[] = [
      { name: "anti-suppression", run: async () => { ran.push("anti-suppression"); return pass(); } },
      { name: "anti-regression", run: async () => { ran.push("anti-regression"); return reject("regression", "new finding"); } },
      { name: "typecheck", run: async () => { ran.push("typecheck"); return pass(); } },
    ];

    const outcome = await runGate(checks);

    expect(outcome).toStrictEqual({
      kept: false,
      reason: "regression",
      detail: "new finding",
      failedCheck: "anti-regression",
    });
    // the check after the failing one never runs
    expect(ran).toStrictEqual(["anti-suppression", "anti-regression"]);
  });
});
