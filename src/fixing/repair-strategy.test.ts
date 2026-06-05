import { describe, expect, it } from "vitest";
import { makeFinding } from "../../test/helpers/make-finding.js";
import { planRepair } from "./repair-strategy.js";

describe("planRepair", () => {
  it("classifies same-file jscpd duplicates as a single-file AI edit", () => {
    const finding = makeFinding({
      tool: "jscpd",
      rule: "duplicate-code",
      category: "duplication",
      file: "src/a.ts",
      flowPath: [
        { file: "src/a.ts", line: 1 },
        { file: "src/a.ts", line: 20 },
      ],
    });

    expect(planRepair({ finding })).toMatchObject({
      strategy: "single-file-ai-edit",
      editableFiles: ["src/a.ts"],
      verificationTargets: ["src/a.ts"],
    });
  });

  it("classifies eligible cross-file jscpd duplicates as a multi-file refactor", () => {
    const finding = makeFinding({
      tool: "jscpd",
      rule: "duplicate-code",
      category: "duplication",
      file: "src/a.ts",
      flowPath: [
        { file: "src/a.ts", line: 1 },
        { file: "src/b.ts", line: 20 },
      ],
    });

    expect(planRepair({ finding })).toMatchObject({
      strategy: "multi-file-duplicate-refactor",
      editableFiles: ["src/a.ts", "src/b.ts"],
      verificationTargets: ["src/a.ts", "src/b.ts"],
    });
  });

  it("returns the exact exclusion reason for cross-file jscpd when a clone file is excluded", () => {
    const finding = makeFinding({
      tool: "jscpd",
      rule: "duplicate-code",
      category: "duplication",
      file: "src/a.ts",
      flowPath: [
        { file: "src/a.ts", line: 1 },
        { file: "dist/b.ts", line: 20 },
      ],
    });

    expect(planRepair({ finding })).toMatchObject({
      strategy: "unsupported",
      editableFiles: [],
      reason: "generated",
    });
  });

  it("classifies ESLint/Sonar autofixable findings as deterministic eslint fixes", () => {
    const finding = makeFinding({
      tool: "sonarjs",
      rule: "curly",
      file: "src/a.ts",
      message: "Expected { after if condition.",
      autofixable: true,
    });

    expect(planRepair({ finding })).toMatchObject({
      strategy: "deterministic-eslint-fix",
      editableFiles: ["src/a.ts"],
      verificationTargets: ["src/a.ts"],
    });
  });

  it("classifies unused imports as TypeScript organize imports", () => {
    const finding = makeFinding({
      tool: "sonarjs",
      rule: "unused-imports/no-unused-imports",
      file: "src/a.ts",
      message: "Unused import: readFile",
    });

    expect(planRepair({ finding })).toMatchObject({
      strategy: "deterministic-ts-organize-imports",
      editableFiles: ["src/a.ts"],
    });
  });

  it("classifies package.json unused dependencies as package cleanup", () => {
    const finding = makeFinding({
      tool: "knip",
      rule: "unused-dependency",
      category: "dead-code",
      file: "package.json",
      message: "Unused dependency: jquery",
    });

    expect(planRepair({ finding })).toMatchObject({
      strategy: "deterministic-package-json-cleanup",
      editableFiles: ["package.json"],
    });
  });

  it("classifies dead-code findings as AI dead-code cleanup", () => {
    const finding = makeFinding({
      tool: "knip",
      rule: "unused-export",
      category: "dead-code",
      file: "src/unused.ts",
      message: "Unused export: unusedHelper",
    });

    expect(planRepair({ finding })).toMatchObject({
      strategy: "dead-code-cleanup",
      editableFiles: ["src/unused.ts"],
      verificationTargets: ["src/unused.ts"],
    });
  });

  it("classifies included test files as test-file repairs", () => {
    const finding = makeFinding({
      tool: "sonarjs",
      file: "src/a.test.ts",
    });

    expect(
      planRepair({
        finding,
        scope: { inFixScope: false, scopeExclusionReason: "tests" },
        config: { includeTests: true },
      }),
    ).toMatchObject({
      strategy: "test-file-repair",
      editableFiles: ["src/a.test.ts"],
      verificationTargets: ["src/a.test.ts"],
    });
  });

  it("classifies generated files with source owners as source repairs", () => {
    const finding = makeFinding({
      tool: "sonarjs",
      file: "dist/api-client.ts",
      flowPath: [
        { file: "src/api-schema.ts", line: 1 },
        { file: "dist/api-client.ts", line: 1 },
      ],
    });

    expect(planRepair({ finding })).toMatchObject({
      strategy: "generated-source-repair",
      editableFiles: ["src/api-schema.ts"],
      verificationTargets: ["dist/api-client.ts", "src/api-schema.ts"],
    });
  });

  it("does not repair generated files when no source owner is found", () => {
    const finding = makeFinding({
      tool: "sonarjs",
      file: "dist/api-client.ts",
    });

    expect(planRepair({ finding })).toMatchObject({
      strategy: "unsupported",
      reason: "generated-source-not-found",
      editableFiles: [],
    });
  });
});
