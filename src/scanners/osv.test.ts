import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ScanContext, SpawnResult } from "./scanner.js";
import { osvScanner } from "./osv.js";

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../test/fixtures/scanner-outputs/${name}`, import.meta.url)), "utf8");

const ctx: ScanContext = { cwd: "/repo", files: [], loop: 1 };
const raw = (stdout: string): SpawnResult => ({ stdout, stderr: "", exitCode: 0 });

describe("osvScanner.parse", () => {
  it("T-030: fixture → vuln-dep findings with remediation (version bump)", () => {
    const findings = osvScanner.parse(raw(fixture("osv.json")), ctx);

    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f).toMatchObject({
      tool: "osv",
      category: "vuln-dep",
      rule: "GHSA-p6mc-m468-83gw",
      file: "package-lock.json",
    });
    // the remediation captures the version bump to the fixed release
    expect(f.remediation).toContain("4.17.19");
    expect(f.remediation).toContain("lodash");
  });

  it("T-032: empty output → []", () => {
    expect(osvScanner.parse(raw('{"results":[]}'), ctx)).toStrictEqual([]);
  });
});
