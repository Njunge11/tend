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

  it("T-002: changing tool, rule, file, or message → different fingerprint", () => {
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
    expect(fingerprint({ ...base, message: "Something else" })).not.toBe(baseId);
  });

  it("T-002b: shifting line within a 5-line bucket does NOT change fingerprint", () => {
    const base = {
      tool: "sonarjs",
      rule: "no-identical-expressions",
      file: "src/auth/login.ts",
      line: 42,
      message: "Identical sub-expressions",
    } as const;

    expect(fingerprint({ ...base, line: 40 })).toBe(fingerprint({ ...base, line: 42 }));
    expect(fingerprint({ ...base, line: 43 })).toBe(fingerprint({ ...base, line: 44 }));
  });

  it("T-002c: shifting line across a bucket boundary changes fingerprint", () => {
    const base = {
      tool: "sonarjs",
      rule: "eqeqeq",
      file: "src/a.ts",
      line: 44,
      message: "Expected '===' and instead saw '=='.",
    } as const;

    expect(fingerprint({ ...base, line: 44 })).not.toBe(
      fingerprint({ ...base, line: 46 }),
    );
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

  it("T-004: message line:col references are normalized so position drift is ignored", () => {
    const base = {
      tool: "jscpd",
      rule: "duplicate-code",
      file: "src/a.ts",
      line: 10,
    } as const;

    const a = fingerprint({ ...base, message: "Duplicated 15 lines, also at src/b.ts:10-25" });
    const b = fingerprint({ ...base, message: "Duplicated 15 lines, also at src/b.ts:12-27" });

    expect(a).toBe(b);
  });

  it("T-005: normalizes 'line N' references in messages", () => {
    const base = {
      tool: "semgrep",
      rule: "some-rule",
      file: "src/a.ts",
      line: 10,
    } as const;

    const a = fingerprint({ ...base, message: "issue at line 42 column 5" });
    const b = fingerprint({ ...base, message: "issue at line 50 column 5" });

    expect(a).toBe(b);
  });
});
