import { describe, expect, it, vi } from "vitest";
import { makeFinding } from "../../test/helpers/make-finding.js";
import type { Finding } from "./finding.js";
import { route } from "./router.js";

describe("route", () => {
  it("T-015: sonarjs/knip/jscpd/semgrep → ai-fix", () => {
    const findings = [
      makeFinding({ tool: "sonarjs", file: "src/a.ts" }),
      makeFinding({ tool: "knip", rule: "unused", category: "dead-code", file: "src/b.ts" }),
      makeFinding({ tool: "jscpd", rule: "dup", category: "duplication", file: "src/c.ts" }),
      makeFinding({ tool: "semgrep", rule: "taint", category: "security", file: "src/d.ts" }),
    ];

    const r = route(findings);

    expect(r.aiFix).toHaveLength(4);
    expect(r.deterministic).toHaveLength(0);
    expect(r.reportOnly).toHaveLength(0);
    expect(r.skipped).toHaveLength(0);
  });

  it("keeps same-file jscpd duplicate-code findings on ai-fix", () => {
    const sameFileDuplicate = makeFinding({
      tool: "jscpd",
      rule: "duplicate-code",
      category: "duplication",
      file: "src/a.ts",
      flowPath: [
        { file: "src/a.ts", line: 10 },
        { file: "src/a.ts", line: 40 },
      ],
    });

    const r = route([sameFileDuplicate]);

    expect(sameFileDuplicate.track).toBe("ai-fix");
    expect(r.aiFix).toStrictEqual([sameFileDuplicate]);
    expect(r.reportOnly).toHaveLength(0);
  });

  it("keeps cross-file jscpd duplicate-code findings on ai-fix for repair planning", () => {
    const crossFileDuplicate = makeFinding({
      tool: "jscpd",
      rule: "duplicate-code",
      category: "duplication",
      file: "src/a.ts",
      flowPath: [
        { file: "src/a.ts", line: 10 },
        { file: "src/b.ts", line: 40 },
      ],
    });

    const r = route([crossFileDuplicate]);

    expect(crossFileDuplicate.track).toBe("ai-fix");
    expect(crossFileDuplicate.remediation).toBeUndefined();
    expect(r.aiFix).toStrictEqual([crossFileDuplicate]);
    expect(r.reportOnly).toHaveLength(0);
  });

  it("considers the second jscpd flowPath file when detecting cross-file duplication", () => {
    const duplicate = makeFinding({
      tool: "jscpd",
      rule: "duplicate-code",
      category: "duplication",
      file: "src/a.ts",
      flowPath: [
        { file: "src/a.ts", line: 10 },
        { file: "src/clone.ts", line: 40 },
      ],
    });

    const r = route([duplicate]);

    expect(r.aiFix.map((f) => f.file)).toStrictEqual(["src/a.ts"]);
    expect(r.aiFix[0]?.flowPath?.[1]).toStrictEqual({ file: "src/clone.ts", line: 40 });
  });

  it("T-016: osv → deterministic", () => {
    const osv = makeFinding(
      { tool: "osv", rule: "CVE-1", category: "vuln-dep", file: "package.json" },
      1,
    );

    const r = route([osv]);

    expect(r.deterministic).toStrictEqual([osv]);
    expect(r.aiFix).toHaveLength(0);
  });

  it("T-017: gitleaks → report-only", () => {
    const secret = makeFinding(
      { tool: "gitleaks", rule: "aws-key", category: "secret", file: "config/prod.ts" },
      1,
    );

    const r = route([secret]);

    expect(r.reportOnly).toStrictEqual([secret]);
    expect(r.aiFix).toHaveLength(0);
  });

  it("T-018: unknown tool → skipped with a warning, not fatal", () => {
    const warn = vi.fn();
    const unknown = { ...makeFinding({ file: "src/x.ts" }), tool: "mystery" } as unknown as Finding;

    const r = route([unknown], { warn });

    expect(r.skipped).toStrictEqual([unknown]);
    expect(r.aiFix).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("mystery");
  });
});
