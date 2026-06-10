import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultEslintConfigPath,
  defaultEslintTypedConfigPath,
  eslintMode,
  findTsconfigDir,
  projectConfiguresSonarjs,
  projectHasEslintConfig,
} from "./eslint-default-config.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tend-eslint-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const pkg = (obj: unknown) => writeFileSync(join(dir, "package.json"), JSON.stringify(obj));
const file = (name: string, body = "") => writeFileSync(join(dir, name), body);

describe("defaultEslintConfigPath", () => {
  it("points at the shipped default config file, which exists", () => {
    expect(existsSync(defaultEslintConfigPath())).toBe(true);
  });
  it("the shipped typed variant exists too", () => {
    expect(existsSync(defaultEslintTypedConfigPath())).toBe(true);
  });
});

describe("findTsconfigDir", () => {
  it("finds a tsconfig in the start dir itself", () => {
    file("tsconfig.json", "{}");
    expect(findTsconfigDir(dir, dir)).toBe(dir);
  });
  it("walks up to the boundary and finds an ancestor tsconfig", () => {
    file("tsconfig.json", "{}");
    const nested = join(dir, "src", "deep");
    mkdirSync(nested, { recursive: true });
    expect(findTsconfigDir(nested, dir)).toBe(dir);
  });
  it("null when no tsconfig exists up to the boundary", () => {
    const nested = join(dir, "src");
    mkdirSync(nested);
    expect(findTsconfigDir(nested, dir)).toBeNull();
  });
});

describe("projectHasEslintConfig", () => {
  it("false when there's no config file or eslintConfig key", () => {
    pkg({ name: "x" });
    expect(projectHasEslintConfig(dir)).toBe(false);
  });
  it("true with an eslint.config.* file", () => {
    file("eslint.config.mjs", "export default [];");
    expect(projectHasEslintConfig(dir)).toBe(true);
  });
  it("true with an eslintConfig key in package.json", () => {
    pkg({ name: "x", eslintConfig: { rules: {} } });
    expect(projectHasEslintConfig(dir)).toBe(true);
  });
});

describe("projectConfiguresSonarjs", () => {
  it("true only when sonarjs is a dep AND referenced in a config", () => {
    pkg({ devDependencies: { "eslint-plugin-sonarjs": "^3" } });
    expect(projectConfiguresSonarjs(dir)).toBe(false); // dep but not referenced

    file("eslint.config.js", "import sonarjs from 'eslint-plugin-sonarjs'; export default [];");
    expect(projectConfiguresSonarjs(dir)).toBe(true);
  });
});

describe("eslintMode — the three cases", () => {
  it("no eslint config → default (tend's config)", () => {
    pkg({ name: "x" });
    expect(eslintMode(dir)).toBe("default");
  });
  it("eslint config without sonarjs → layer (their config + sonarjs)", () => {
    pkg({ devDependencies: { eslint: "^9" } });
    file("eslint.config.mjs", "export default [{ rules: {} }];");
    expect(eslintMode(dir)).toBe("layer");
  });
  it("eslint config including sonarjs → defer (theirs untouched)", () => {
    pkg({ devDependencies: { "eslint-plugin-sonarjs": "^3" } });
    file("eslint.config.mjs", "import sonarjs from 'eslint-plugin-sonarjs'; export default [];");
    expect(eslintMode(dir)).toBe("defer");
  });
});
