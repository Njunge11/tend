import { describe, expect, it } from "vitest";
import { fingerprint } from "./finding.js";

describe("fingerprint", () => {
  it("T-001: same tool|rule|file|line|message → identical fingerprint", () => {
    const components = {
      tool: "sonarjs",
      rule: "no-identical-expressions",
      file: "src/auth/login.ts",
      line: 42,
      message: "Identical sub-expressions on both sides of operator",
    } as const;

    const a = fingerprint(components);
    const b = fingerprint({ ...components });

    expect(a).toBe(b);
  });

  it("T-002: changing any one component → different fingerprint", () => {
    const base = {
      tool: "sonarjs",
      rule: "no-identical-expressions",
      file: "src/auth/login.ts",
      line: 42,
      message: "Identical sub-expressions",
    } as const;
    const baseId = fingerprint(base);

    expect(fingerprint({ ...base, tool: "knip" })).not.toBe(baseId);
    expect(fingerprint({ ...base, rule: "no-dead-code" })).not.toBe(baseId);
    expect(fingerprint({ ...base, file: "src/auth/logout.ts" })).not.toBe(baseId);
    expect(fingerprint({ ...base, line: 43 })).not.toBe(baseId);
    expect(fingerprint({ ...base, message: "Something else" })).not.toBe(baseId);
  });

  it("T-003: same logical issue reported by two different tools → different fingerprints", () => {
    const sharedLocation = {
      rule: "duplicate-code",
      file: "src/api/client.ts",
      line: 88,
      message: "Duplicated block",
    } as const;

    const fromJscpd = fingerprint({ ...sharedLocation, tool: "jscpd" });
    const fromSonar = fingerprint({ ...sharedLocation, tool: "sonarjs" });

    expect(fromJscpd).not.toBe(fromSonar);
  });
});
