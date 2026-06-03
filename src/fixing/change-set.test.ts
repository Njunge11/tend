import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChangeSet } from "./change-set.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tend-cs-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const read = (p: string) => readFileSync(join(dir, p), "utf8");
const seed = (p: string, c: string) => {
  const abs = join(dir, p);
  mkdirSync(join(dir, p, ".."), { recursive: true });
  writeFileSync(abs, c);
};

describe("ChangeSet", () => {
  it("T-065: apply writes edits to the working tree", () => {
    const cs = new ChangeSet([{ path: join(dir, "src/a.ts"), contents: "export const a = 2;\n" }]);
    cs.apply();
    expect(read("src/a.ts")).toBe("export const a = 2;\n");
  });

  it("T-066: revert restores file(s) to pre-change state", () => {
    seed("src/a.ts", "export const a = 1;\n");
    const cs = new ChangeSet([{ path: join(dir, "src/a.ts"), contents: "export const a = 2;\n" }]);
    cs.apply();
    cs.revert();
    expect(read("src/a.ts")).toBe("export const a = 1;\n");
  });

  it("T-067: atomic — code + sibling test revert together", () => {
    seed("src/a.ts", "CODE_OLD\n");
    seed("src/a.test.ts", "TEST_OLD\n");
    const cs = new ChangeSet([
      { path: join(dir, "src/a.ts"), contents: "CODE_NEW\n" },
      { path: join(dir, "src/a.test.ts"), contents: "TEST_NEW\n" },
    ]);
    cs.apply();
    expect(read("src/a.ts")).toBe("CODE_NEW\n");
    expect(read("src/a.test.ts")).toBe("TEST_NEW\n");

    cs.revert();
    expect(read("src/a.ts")).toBe("CODE_OLD\n");
    expect(read("src/a.test.ts")).toBe("TEST_OLD\n");
  });

  it("T-068: revert after a partial apply → clean restore", () => {
    // second edit targets a directory path → writeFileSync throws mid-apply
    mkdirSync(join(dir, "blocked"));
    const cs = new ChangeSet([
      { path: join(dir, "src/new.ts"), contents: "NEW_FILE\n" },
      { path: join(dir, "blocked"), contents: "boom\n" },
    ]);

    expect(() => cs.apply()).toThrow();
    cs.revert();

    // the newly-created file from the partial apply is cleaned up
    expect(existsSync(join(dir, "src/new.ts"))).toBe(false);
  });
});
