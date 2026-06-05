import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeFinding } from "../../test/helpers/make-finding.js";
import { isGeneratedArtifact, resolveGeneratedSourceOwner } from "./generated-source.js";
import { planRepair } from "./repair-strategy.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tend-generated-source-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(rel: string, contents: string): void {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
}

describe("generated artifact detection", () => {
  it("detects files under generated output directories", () => {
    expect(isGeneratedArtifact(dir, "dist/index.js")).toBe(true);
    expect(isGeneratedArtifact(dir, "build/index.js")).toBe(true);
    expect(isGeneratedArtifact(dir, "out/index.js")).toBe(true);
    expect(isGeneratedArtifact(dir, "src/index.ts")).toBe(false);
  });

  it("detects emitted declaration artifacts under generated output", () => {
    expect(isGeneratedArtifact(dir, "dist/index.d.ts")).toBe(true);
    expect(isGeneratedArtifact(dir, "dist/index.d.ts.map")).toBe(true);
    expect(isGeneratedArtifact(dir, "src/index.d.ts")).toBe(false);
  });

  it("detects sourceMappingURL files when the source map exists", () => {
    write("lib/client.js", "export const value = 1;\n//# sourceMappingURL=client.js.map\n");
    write("lib/client.js.map", JSON.stringify({ version: 3, sources: ["../src/client.ts"] }));

    expect(isGeneratedArtifact(dir, "lib/client.js")).toBe(true);
  });
});

describe("generated source owner resolution", () => {
  it("resolves source owners through JavaScript source maps", () => {
    write("src/client.ts", "export const value = 1;\n");
    write("dist/client.js", "export const value = 1;\n//# sourceMappingURL=client.js.map\n");
    write("dist/client.js.map", JSON.stringify({ version: 3, sources: ["../src/client.ts"] }));

    expect(resolveGeneratedSourceOwner(dir, "dist/client.js")).toStrictEqual({
      generatedFile: "dist/client.js",
      sourceOwner: "src/client.ts",
      sourceMap: "dist/client.js.map",
    });
  });

  it("resolves source owners through TypeScript declaration maps", () => {
    write("src/types.ts", "export type Thing = { id: string };\n");
    write("dist/types.d.ts", "export type Thing = { id: string };\n//# sourceMappingURL=types.d.ts.map\n");
    write("dist/types.d.ts.map", JSON.stringify({ version: 3, sources: ["../src/types.ts"] }));

    expect(resolveGeneratedSourceOwner(dir, "dist/types.d.ts")?.sourceOwner).toBe("src/types.ts");
  });

  it("resolves obvious package build config output to tsdown entry source", () => {
    write("package.json", JSON.stringify({ bin: { tend: "./dist/bin.js" }, scripts: { build: "tsdown" } }));
    write("tsdown.config.ts", 'export default defineConfig({ entry: ["src/bin.ts"], dts: true });\n');
    write("src/bin.ts", "export function main() {}\n");
    write("dist/bin.js", "export function main() {}\n");

    expect(resolveGeneratedSourceOwner(dir, "dist/bin.js")?.sourceOwner).toBe("src/bin.ts");
  });
});

describe("generated-source repair planning", () => {
  it("plans source repair for a generated finding with a source owner", () => {
    write("src/client.ts", "export const value = 1;\n");
    write("dist/client.js", "export const value = 1;\n//# sourceMappingURL=client.js.map\n");
    write("dist/client.js.map", JSON.stringify({ version: 3, sources: ["../src/client.ts"] }));
    const finding = makeFinding({ file: "dist/client.js" });

    expect(planRepair({ finding, cwd: dir })).toMatchObject({
      strategy: "generated-source-repair",
      editableFiles: ["src/client.ts"],
      verificationTargets: ["dist/client.js", "src/client.ts"],
    });
  });

  it("does not send generated findings without a source owner to generic AI edit", () => {
    write("dist/client.js", "export const value = 1;\n");
    const finding = makeFinding({ file: "dist/client.js" });

    expect(planRepair({ finding, cwd: dir })).toMatchObject({
      strategy: "unsupported",
      reason: "generated-source-not-found",
      editableFiles: [],
    });
  });
});
