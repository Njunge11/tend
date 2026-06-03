import { describe, expect, it } from "vitest";
import { fingerprint } from "./finding.js";
import { normalize, type RawFinding } from "./normalize.js";

const rawSonar: RawFinding = {
  tool: "sonarjs",
  rule: "no-identical-expressions",
  category: "bug",
  severity: "error",
  file: "src/auth/login.ts",
  range: { startLine: 42, startCol: 5, endLine: 42, endCol: 30 },
  message: "Identical sub-expressions on both sides of operator",
};

describe("normalize", () => {
  it("T-004: a raw record normalizes into a Finding with all required fields", () => {
    const f = normalize(rawSonar, 1);

    expect(f).toStrictEqual({
      id: fingerprint({
        tool: "sonarjs",
        rule: "no-identical-expressions",
        file: "src/auth/login.ts",
        line: 42,
        message: "Identical sub-expressions on both sides of operator",
      }),
      tool: "sonarjs",
      rule: "no-identical-expressions",
      category: "bug",
      severity: "error",
      file: "src/auth/login.ts",
      range: { startLine: 42, startCol: 5, endLine: 42, endCol: 30 },
      message: "Identical sub-expressions on both sides of operator",
      track: "ai-fix",
      status: "pending",
      attempts: 0,
      firstSeenLoop: 1,
      lastSeenLoop: 1,
    });
  });

  it("T-005: optional fields absent (helpUri/flowPath/remediation) → still a valid Finding", () => {
    const f = normalize(rawSonar, 1);

    expect(f.helpUri).toBeUndefined();
    expect(f.flowPath).toBeUndefined();
    expect(f.remediation).toBeUndefined();
    expect(() => assertValidFinding(f)).not.toThrow();
  });
});

// local helper kept inline to avoid importing the schema before T-005 demands it
import { FindingSchema } from "./finding.js";
function assertValidFinding(value: unknown): void {
  FindingSchema.parse(value);
}
