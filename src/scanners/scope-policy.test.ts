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

  it("exclude with brace alternation excludes every alternative (fails CLOSED, not open)", () => {
    const exclude = ["src/legacy/**/*.{ts,tsx}"];
    for (const file of ["src/legacy/a.ts", "src/legacy/deep/nested/b.tsx"]) {
      expect(classifyScope(makeFinding({ file }), { exclude })).toStrictEqual({
        inReportScope: true,
        inFixScope: false,
        scopeExclusionReason: "out-of-scope",
      });
    }
    expect(classifyScope(makeFinding({ file: "src/legacy/styles.css" }), { exclude })).toStrictEqual({
      inReportScope: true,
      inFixScope: true,
    });
  });

  it("include with a character class matches the listed characters only", () => {
    const include = ["dist/[ab].d.ts"];
    for (const file of ["dist/a.d.ts", "dist/b.d.ts"]) {
      expect(classifyScope(makeFinding({ file }), { include })).toStrictEqual({
        inReportScope: true,
        inFixScope: true,
      });
    }
    expect(classifyScope(makeFinding({ file: "dist/c.d.ts" }), { include })).toStrictEqual({
      inReportScope: true,
      inFixScope: false,
      scopeExclusionReason: "generated",
    });
  });

  it("supports ranges and negated character classes ([a-z], [!ab]/[^ab])", () => {
    const ranged = ["src/legacy/[a-c].ts"];
    expect(classifyScope(makeFinding({ file: "src/legacy/b.ts" }), { exclude: ranged }).inFixScope).toBe(false);
    expect(classifyScope(makeFinding({ file: "src/legacy/d.ts" }), { exclude: ranged }).inFixScope).toBe(true);

    for (const negated of ["src/legacy/[!ab].ts", "src/legacy/[^ab].ts"]) {
      expect(classifyScope(makeFinding({ file: "src/legacy/c.ts" }), { exclude: [negated] }).inFixScope).toBe(false);
      expect(classifyScope(makeFinding({ file: "src/legacy/a.ts" }), { exclude: [negated] }).inFixScope).toBe(true);
    }
  });

  it("supports nested brace alternation", () => {
    const exclude = ["src/{legacy,old/{v1,v2}}/**"];
    for (const file of ["src/legacy/a.ts", "src/old/v1/b.ts", "src/old/v2/c.ts"]) {
      expect(classifyScope(makeFinding({ file }), { exclude }).inFixScope).toBe(false);
    }
    expect(classifyScope(makeFinding({ file: "src/old/v3/d.ts" }), { exclude }).inFixScope).toBe(true);
  });

  it("treats an unmatched brace or empty class as a literal character", () => {
    // `{` with no closing brace: matches a file literally named with the brace.
    expect(classifyScope(makeFinding({ file: "src/{weird.ts" }), { exclude: ["src/{weird.ts"] }).inFixScope).toBe(
      false,
    );
    expect(classifyScope(makeFinding({ file: "src/weird.ts" }), { exclude: ["src/{weird.ts"] }).inFixScope).toBe(
      true,
    );
    // `[]` with no body: literal brackets, still a valid pattern.
    expect(classifyScope(makeFinding({ file: "src/a[].ts" }), { exclude: ["src/a[].ts"] }).inFixScope).toBe(false);
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
