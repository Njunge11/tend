import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ScanContext, SpawnResult } from "./scanner.js";
import { knipScanner } from "./knip.js";

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../test/fixtures/scanner-outputs/${name}`, import.meta.url)), "utf8");

const ctx: ScanContext = { cwd: "/repo", files: [], loop: 1 };
const raw = (stdout: string): SpawnResult => ({ stdout, stderr: "", exitCode: 0 });

describe("knipScanner.parse", () => {
  it("T-026: fixture → expected unused files/exports/deps findings", () => {
    const findings = knipScanner.parse(raw(fixture("knip.json")), ctx);

    expect(findings).toHaveLength(3);
    expect(findings.every((f) => f.tool === "knip" && f.category === "dead-code")).toBe(true);

    const dep = findings.find((f) => f.rule === "unused-dependency");
    expect(dep).toMatchObject({ file: "package.json", range: { startLine: 5 } });
    expect(dep?.message).toContain("jquery");

    const file = findings.find((f) => f.rule === "unused-file");
    expect(file).toMatchObject({ file: "src/unused-file.ts" });

    const exp = findings.find((f) => f.rule === "unused-export");
    expect(exp).toMatchObject({ file: "src/widget.ts", range: { startLine: 8 } });
    expect(exp?.message).toContain("unusedHelper");
  });

  it("T-139: top-level `files` array (knip's real shape for unused files) → unused-file findings", () => {
    // knip reports unused FILES as a top-level string array, not nested under issues[].
    const findings = knipScanner.parse(
      raw('{"files":["src/orphan.ts","src/dead.ts"],"issues":[]}'),
      ctx,
    );

    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.rule === "unused-file" && f.category === "dead-code")).toBe(true);
    expect(findings.map((f) => f.file)).toStrictEqual(["src/orphan.ts", "src/dead.ts"]);
    expect(findings[0]?.message).toContain("src/orphan.ts");
  });

  it("T-032: empty output → []", () => {
    expect(knipScanner.parse(raw('{"files":[],"issues":[]}'), ctx)).toStrictEqual([]);
  });
});
