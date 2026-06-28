import { describe, expect, it } from "vitest";
import { makeFinding } from "../../test/helpers/make-finding.js";
import { effortForFindings, effortForUnit, minEffort } from "./effort.js";

const mechanical = makeFinding({ tool: "knip", rule: "unused-export", category: "dead-code", file: "src/a.ts" });
const autofixable = makeFinding({ tool: "sonarjs", rule: "curly", file: "src/a.ts", autofixable: true });
const reasoning = makeFinding({ tool: "sonarjs", rule: "cognitive-complexity", category: "smell", file: "src/a.ts" });

describe("effortForFindings", () => {
  it("uses the cheapest tier for all-mechanical units", () => {
    expect(effortForFindings([mechanical, autofixable])).toBe("low");
  });

  it("uses medium when any finding needs real reasoning", () => {
    expect(effortForFindings([mechanical, reasoning])).toBe("medium");
  });

  it("defaults an empty unit to medium", () => {
    expect(effortForFindings([])).toBe("medium");
  });
});

describe("minEffort", () => {
  it("returns the lower of two levels", () => {
    expect(minEffort("high", "low")).toBe("low");
    expect(minEffort("low", "max")).toBe("low");
    expect(minEffort("medium", "high")).toBe("medium");
  });
});

describe("effortForUnit — config.effort is a ceiling, not an override", () => {
  it("keeps a mechanical unit cheap even when config.effort is high", () => {
    expect(effortForUnit([mechanical], "high")).toBe("low");
  });

  it("caps a reasoning unit at the configured ceiling", () => {
    expect(effortForUnit([reasoning], "low")).toBe("low");
  });

  it("does not raise a mechanical unit up to the configured ceiling (the override bug)", () => {
    // Before the fix, config.effort overrode the per-finding effort, forcing dead-code deletes to
    // run at the expensive configured tier. Now the cheaper per-finding effort wins.
    expect(effortForUnit([mechanical], "max")).toBe("low");
  });

  it("falls back to the per-finding effort when no config.effort is set", () => {
    expect(effortForUnit([reasoning])).toBe("medium");
    expect(effortForUnit([mechanical])).toBe("low");
  });
});
