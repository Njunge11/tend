import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyCliOverrides, loadConfig } from "./config.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tend-config-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("loadConfig", () => {
  it("T-090: loads config file via cosmiconfig", async () => {
    writeFileSync(join(dir, ".tendrc.json"), JSON.stringify({ maxLoops: 9, teethCheck: false }));
    const config = await loadConfig(dir);
    expect(config.maxLoops).toBe(9);
    expect(config.teethCheck).toBe(false);
  });

  it("T-091: zero-config defaults applied when no file", async () => {
    const config = await loadConfig(dir);
    expect(config).toMatchObject({
      maxSessions: 4,
      maxLoops: 5,
      perIssueBudget: 3,
      teethCheck: true,
      includeTests: false,
      model: "sonnet",
    });
  });

  it("model: defaults to sonnet, overridable by config file and CLI flag", async () => {
    expect((await loadConfig(dir)).model).toBe("sonnet");

    writeFileSync(join(dir, ".tendrc.json"), JSON.stringify({ model: "opus" }));
    expect((await loadConfig(dir)).model).toBe("opus");

    const merged = applyCliOverrides(await loadConfig(dir), { model: "claude-haiku-4-5" });
    expect(merged.model).toBe("claude-haiku-4-5");
  });

  it("effort: optional, accepts valid levels, rejects invalid ones", async () => {
    expect((await loadConfig(dir)).effort).toBeUndefined(); // unset by default

    writeFileSync(join(dir, ".tendrc.json"), JSON.stringify({ effort: "high" }));
    expect((await loadConfig(dir)).effort).toBe("high");

    writeFileSync(join(dir, ".tendrc.json"), JSON.stringify({ effort: "turbo" }));
    await expect(loadConfig(dir)).rejects.toThrow(/effort/);
  });

  it("T-092: invalid config rejected by zod with a clear message", async () => {
    writeFileSync(join(dir, ".tendrc.json"), JSON.stringify({ maxLoops: -1 }));
    await expect(loadConfig(dir)).rejects.toThrow(/maxLoops/);
  });
});

describe("applyCliOverrides", () => {
  it("T-093: CLI flags override config (maxLoops, maxSessions, …)", async () => {
    const base = await loadConfig(dir); // defaults
    const merged = applyCliOverrides(base, { maxLoops: 1, maxSessions: 8 });
    expect(merged.maxLoops).toBe(1);
    expect(merged.maxSessions).toBe(8);
    expect(merged.perIssueBudget).toBe(3); // untouched
  });
});
