import { describe, expect, it } from "vitest";
import { makeFinding } from "../../test/helpers/make-finding.js";
import { CAPABLE_MODEL, DEFAULT_MODEL, distinctRunModels, modelForUnit } from "./model-selection.js";

const config = { model: DEFAULT_MODEL };

describe("modelForUnit", () => {
  it("pins both tiers to full model+version ids", () => {
    expect(DEFAULT_MODEL).toBe("claude-sonnet-4-6");
    expect(CAPABLE_MODEL).toBe("claude-opus-4-8");
  });

  it("uses the capable model for duplication findings", () => {
    const unit = [makeFinding({ category: "duplication", tool: "jscpd" })];
    expect(modelForUnit(unit, config)).toBe(CAPABLE_MODEL);
  });

  it("uses the capable model for cognitive-complexity findings (matched by rule)", () => {
    const unit = [makeFinding({ rule: "sonarjs/cognitive-complexity", category: "smell" })];
    expect(modelForUnit(unit, config)).toBe(CAPABLE_MODEL);
  });

  it("uses the capable model for knip unused-file cleanup", () => {
    const unit = [
      makeFinding({
        tool: "knip",
        rule: "unused-file",
        category: "dead-code",
        file: "apps/admin/lib/trpc/query-client.ts",
      }),
    ];
    expect(modelForUnit(unit, config)).toBe(CAPABLE_MODEL);
  });

  it("uses the capable model for knip unused exports in wiring-heavy files", () => {
    const unit = [
      makeFinding({
        tool: "knip",
        rule: "unused-export",
        category: "dead-code",
        file: "apps/admin/lib/db/index.ts",
      }),
    ];
    expect(modelForUnit(unit, config)).toBe(CAPABLE_MODEL);
  });

  it("keeps simple knip unused exports on the default model", () => {
    const unit = [
      makeFinding({
        tool: "knip",
        rule: "unused-export",
        category: "dead-code",
        file: "apps/admin/lib/format-name.ts",
      }),
    ];
    expect(modelForUnit(unit, config)).toBe(DEFAULT_MODEL);
  });

  it("uses the default model for non-duplication findings", () => {
    expect(modelForUnit([makeFinding({ category: "dead-code" })], config)).toBe(DEFAULT_MODEL);
    expect(modelForUnit([makeFinding({ category: "smell" })], config)).toBe(DEFAULT_MODEL);
  });

  it("lifts a mixed unit to the capable model if any finding is duplication", () => {
    const unit = [
      makeFinding({ category: "dead-code" }),
      makeFinding({ category: "duplication", tool: "jscpd" }),
    ];
    expect(modelForUnit(unit, config)).toBe(CAPABLE_MODEL);
  });

  it("lifts a mixed unit to the capable model if any finding is a complexity refactor", () => {
    const unit = [
      makeFinding({ category: "dead-code" }),
      makeFinding({ rule: "sonarjs/cognitive-complexity", category: "smell" }),
    ];
    expect(modelForUnit(unit, config)).toBe(CAPABLE_MODEL);
  });

  it("uses the default model for an empty unit", () => {
    expect(modelForUnit([], config)).toBe(DEFAULT_MODEL);
  });

  it("lets a configured duplicationModel override the capable default", () => {
    const unit = [makeFinding({ category: "duplication", tool: "jscpd" })];
    expect(modelForUnit(unit, { model: "sonnet", duplicationModel: "claude-opus-4-7" })).toBe(
      "claude-opus-4-7",
    );
  });

  it("lets a configured complexityModel override the capable default", () => {
    const unit = [makeFinding({ rule: "sonarjs/cognitive-complexity", category: "smell" })];
    expect(modelForUnit(unit, { model: "sonnet", complexityModel: "claude-opus-4-7" })).toBe(
      "claude-opus-4-7",
    );
  });

  it("keeps the overrides scoped to their finding kind", () => {
    // duplicationModel must not leak onto complexity units, nor complexityModel onto
    // duplication units, nor either onto plain findings.
    const complexity = [makeFinding({ rule: "sonarjs/cognitive-complexity", category: "smell" })];
    expect(modelForUnit(complexity, { model: "sonnet", duplicationModel: "claude-opus-4-7" })).toBe(
      CAPABLE_MODEL,
    );
    const duplication = [makeFinding({ category: "duplication", tool: "jscpd" })];
    expect(modelForUnit(duplication, { model: "sonnet", complexityModel: "claude-opus-4-7" })).toBe(
      CAPABLE_MODEL,
    );
    const plain = [makeFinding({ category: "smell" })];
    expect(
      modelForUnit(plain, {
        model: "sonnet",
        duplicationModel: "claude-opus-4-7",
        complexityModel: "claude-opus-4-7",
      }),
    ).toBe("sonnet");
  });

  it("distinctRunModels: default config routes to the default and capable models", () => {
    expect(distinctRunModels({ model: DEFAULT_MODEL })).toEqual([DEFAULT_MODEL, CAPABLE_MODEL]);
  });

  it("distinctRunModels: dedupes when the default already is the capable model", () => {
    expect(distinctRunModels({ model: CAPABLE_MODEL })).toEqual([CAPABLE_MODEL]);
  });

  it("distinctRunModels: includes per-kind overrides", () => {
    expect(
      distinctRunModels({ model: DEFAULT_MODEL, duplicationModel: "dup-model", complexityModel: "cx-model" }),
    ).toEqual([DEFAULT_MODEL, "dup-model", "cx-model"]);
  });

  it("prefers the duplication override when a unit contains both kinds", () => {
    const unit = [
      makeFinding({ category: "duplication", tool: "jscpd" }),
      makeFinding({ rule: "sonarjs/cognitive-complexity", category: "smell" }),
    ];
    expect(
      modelForUnit(unit, { model: "sonnet", duplicationModel: "dup-model", complexityModel: "cx-model" }),
    ).toBe("dup-model");
  });
});
