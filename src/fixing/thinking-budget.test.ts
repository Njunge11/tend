import { describe, expect, it } from "vitest";
import { makeFinding } from "../../test/helpers/make-finding.js";
import {
  THINKING_BUDGET_CAP,
  thinkingBudgetFor,
  thinkingBudgetForUnit,
  thinkingEnv,
} from "./thinking-budget.js";

describe("thinkingBudgetFor", () => {
  it("gives reasoning findings a bounded positive budget", () => {
    const budget = thinkingBudgetFor(
      makeFinding({ category: "smell", rule: "cognitive-complexity" }),
    );
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThanOrEqual(THINKING_BUDGET_CAP);
  });

  it("turns thinking off for mechanical findings (dead-code)", () => {
    expect(thinkingBudgetFor(makeFinding({ category: "dead-code" }))).toBe(0);
  });

  it("lets a configured budget override the per-finding policy", () => {
    const finding = makeFinding({ category: "smell", rule: "cognitive-complexity" });
    expect(thinkingBudgetFor(finding, { thinkingBudget: 12_000 })).toBe(12_000);
  });

  it("respects a configured budget of 0 as thinking off", () => {
    const finding = makeFinding({ category: "smell", rule: "cognitive-complexity" });
    expect(thinkingBudgetFor(finding, { thinkingBudget: 0 })).toBe(0);
  });

  it("falls back to the bounded cap for unrecognized categories (safe default)", () => {
    const finding = makeFinding();
    const unknown = { ...finding, category: "brand-new-category" as typeof finding.category };
    expect(thinkingBudgetFor(unknown)).toBe(THINKING_BUDGET_CAP);
  });

  it("turns thinking off for mechanical findings (autofixable)", () => {
    expect(thinkingBudgetFor(makeFinding({ category: "smell", autofixable: true }))).toBe(0);
  });
});

describe("thinkingBudgetForUnit", () => {
  it("uses the most-conservative budget when a unit mixes categories", () => {
    // A reasoning finding alongside a mechanical one must not be starved of thinking.
    const budget = thinkingBudgetForUnit([
      makeFinding({ category: "dead-code" }),
      makeFinding({ category: "smell", rule: "cognitive-complexity" }),
    ]);
    expect(budget).toBe(THINKING_BUDGET_CAP);
  });

  it("turns thinking off when every finding in the unit is mechanical", () => {
    const budget = thinkingBudgetForUnit([
      makeFinding({ category: "dead-code" }),
      makeFinding({ category: "smell", autofixable: true }),
    ]);
    expect(budget).toBe(0);
  });

  it("falls back to the bounded cap for an empty unit (safe default)", () => {
    expect(thinkingBudgetForUnit([])).toBe(THINKING_BUDGET_CAP);
  });

  it("lets a configured budget override the whole unit", () => {
    const budget = thinkingBudgetForUnit(
      [makeFinding({ category: "dead-code" })],
      { thinkingBudget: 9000 },
    );
    expect(budget).toBe(9000);
  });
});

describe("thinkingEnv (delivery to the claude session boundary)", () => {
  it("disables thinking for a mechanical unit", () => {
    expect(thinkingEnv([makeFinding({ category: "dead-code" })])).toEqual({
      MAX_THINKING_TOKENS: "0",
    });
  });

  it("passes the bounded budget for a reasoning unit", () => {
    expect(
      thinkingEnv([makeFinding({ category: "smell", rule: "cognitive-complexity" })]),
    ).toEqual({ MAX_THINKING_TOKENS: String(THINKING_BUDGET_CAP) });
  });
});
