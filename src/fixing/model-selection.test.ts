import { describe, expect, it } from "vitest";
import { makeFinding } from "../../test/helpers/make-finding.js";
import { DUPLICATION_MODEL, modelForUnit } from "./model-selection.js";

const config = { model: "sonnet" };

describe("modelForUnit", () => {
  it("uses the capable model for duplication findings", () => {
    const unit = [makeFinding({ category: "duplication", tool: "jscpd" })];
    expect(modelForUnit(unit, config)).toBe(DUPLICATION_MODEL);
  });

  it("uses the default model for non-duplication findings", () => {
    expect(modelForUnit([makeFinding({ category: "dead-code" })], config)).toBe("sonnet");
    expect(modelForUnit([makeFinding({ category: "smell" })], config)).toBe("sonnet");
  });

  it("lifts a mixed unit to the capable model if any finding is duplication", () => {
    const unit = [
      makeFinding({ category: "dead-code" }),
      makeFinding({ category: "duplication", tool: "jscpd" }),
    ];
    expect(modelForUnit(unit, config)).toBe(DUPLICATION_MODEL);
  });

  it("uses the default model for an empty unit", () => {
    expect(modelForUnit([], config)).toBe("sonnet");
  });

  it("lets a configured duplicationModel override the capable default", () => {
    const unit = [makeFinding({ category: "duplication", tool: "jscpd" })];
    expect(modelForUnit(unit, { model: "sonnet", duplicationModel: "claude-opus-4-7" })).toBe(
      "claude-opus-4-7",
    );
  });

  it("does not apply duplicationModel to non-duplication findings", () => {
    const unit = [makeFinding({ category: "smell" })];
    expect(modelForUnit(unit, { model: "sonnet", duplicationModel: "claude-opus-4-7" })).toBe(
      "sonnet",
    );
  });
});
