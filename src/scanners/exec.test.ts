import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { realWhich, resolveBundledScanner, resolveProjectScanner } from "./exec.js";

describe("resolveBundledScanner", () => {
  it("resolves bundled npm scanners (knip/jscpd/eslint) to a real bin script", () => {
    for (const bin of ["knip", "jscpd", "eslint"]) {
      const path = resolveBundledScanner(bin);
      expect(path, `${bin} should resolve`).not.toBeNull();
      expect(existsSync(path!)).toBe(true);
    }
  });

  it("returns null for native (non-bundled) scanners", () => {
    expect(resolveBundledScanner("gitleaks")).toBeNull();
    expect(resolveBundledScanner("semgrep")).toBeNull();
    expect(resolveBundledScanner("osv-scanner")).toBeNull();
  });

  it("realWhich reports bundled scanners as available without needing them on PATH", async () => {
    await expect(realWhich("knip")).resolves.toBe(true);
  });
});

describe("resolveProjectScanner", () => {
  it("returns null when the target project has no copy of the scanner", () => {
    const empty = mkdtempSync(join(tmpdir(), "tend-noproj-"));
    try {
      expect(resolveProjectScanner("knip", empty)).toBeNull();
      // tend's bundled copy is still available as the fallback
      expect(resolveBundledScanner("knip")).not.toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
