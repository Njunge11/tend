import { describe, expect, it } from "vitest";
import { makeFinding } from "../../test/helpers/make-finding.js";
import { classifyScope, markScope } from "./scope-policy.js";

describe("scope policy", () => {
  it("keeps source files report-visible and fixable by default", () => {
    const decision = classifyScope(makeFinding({ file: "src/a.ts" }));

    expect(decision).toStrictEqual({
      inReportScope: true,
      inFixScope: true,
    });
  });

  it("reports generated/cache/build artifacts but excludes them from fixes", () => {
    for (const file of [
      ".tend/report.json",
      ".turbo/cache/entry.json",
      ".next/server/app.js",
      ".vercel/output/config.json",
      "coverage/lcov.info",
      "dist/index.d.ts",
      "dist/index.d.ts.map",
      "build/types/api.d.ts",
      "out/app.js",
      "src/generated/client.d.ts",
    ]) {
      expect(classifyScope(makeFinding({ file }))).toStrictEqual({
        inReportScope: true,
        inFixScope: false,
        scopeExclusionReason: "generated",
      });
    }
  });

  it("reports node_modules and .git findings but excludes them as out of scope", () => {
    for (const file of ["node_modules/pkg/index.js", ".git/hooks/pre-commit"]) {
      expect(classifyScope(makeFinding({ file }))).toStrictEqual({
        inReportScope: true,
        inFixScope: false,
        scopeExclusionReason: "out-of-scope",
      });
    }
  });

  it("reports fixtures but excludes them from fixes unless fixtures are included", () => {
    const fixture = makeFinding({ file: "test/fixtures/sample.ts" });

    expect(classifyScope(fixture)).toStrictEqual({
      inReportScope: true,
      inFixScope: false,
      scopeExclusionReason: "fixtures",
    });
    expect(classifyScope(fixture, { includeFixtures: true })).toStrictEqual({
      inReportScope: true,
      inFixScope: true,
    });
  });

  it("reports tests but excludes them from primary fixes unless tests are included", () => {
    const test = makeFinding({ file: "src/a.test.ts" });

    expect(classifyScope(test)).toStrictEqual({
      inReportScope: true,
      inFixScope: false,
      scopeExclusionReason: "tests",
    });
    expect(classifyScope(test, { includeTests: true })).toStrictEqual({
      inReportScope: true,
      inFixScope: true,
    });
  });

  it("lets explicit include opt generated files back into fixes", () => {
    const dist = makeFinding({ file: "dist/index.d.ts" });

    expect(classifyScope(dist, { include: ["dist/index.d.ts"] })).toStrictEqual({
      inReportScope: true,
      inFixScope: true,
    });
  });

  it("lets explicit exclude remove otherwise fixable source files", () => {
    const src = makeFinding({ file: "src/a.ts" });

    expect(classifyScope(src, { exclude: ["src/**"] })).toStrictEqual({
      inReportScope: true,
      inFixScope: false,
      scopeExclusionReason: "out-of-scope",
    });
  });

  it("marks findings in place and clears stale exclusion reasons when included", () => {
    const finding = makeFinding({ file: "dist/index.d.ts" });
    markScope(finding);
    expect(finding.inFixScope).toBe(false);
    expect(finding.scopeExclusionReason).toBe("generated");

    markScope(finding, { includeGenerated: true });
    expect(finding.inFixScope).toBe(true);
    expect(finding.scopeExclusionReason).toBeUndefined();
  });
});
