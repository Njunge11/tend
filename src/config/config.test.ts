import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MODEL } from "../fixing/model-selection.js";
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
      fix: {
        include: [],
        exclude: [],
        includeGenerated: false,
        includeFixtures: false,
      },
      model: DEFAULT_MODEL,
    });
  });

  it("loads fix scope overrides", async () => {
    writeFileSync(
      join(dir, ".tendrc.json"),
      JSON.stringify({
        fix: {
          include: ["dist/index.d.ts"],
          exclude: ["coverage/**"],
          includeGenerated: true,
          includeFixtures: true,
        },
      }),
    );

    expect((await loadConfig(dir)).fix).toStrictEqual({
      include: ["dist/index.d.ts"],
      exclude: ["coverage/**"],
      includeGenerated: true,
      includeFixtures: true,
    });
  });

  it("model: defaults to DEFAULT_MODEL, overridable by config file and CLI flag", async () => {
    expect((await loadConfig(dir)).model).toBe(DEFAULT_MODEL);

    writeFileSync(join(dir, ".tendrc.json"), JSON.stringify({ model: "opus" }));
    expect((await loadConfig(dir)).model).toBe("opus");

    const merged = applyCliOverrides(await loadConfig(dir), { model: "claude-haiku-4-5" });
    expect(merged.model).toBe("claude-haiku-4-5");
  });

  it("duplicationModel: unset by default, overridable by config file and CLI flag", async () => {
    expect((await loadConfig(dir)).duplicationModel).toBeUndefined();

    writeFileSync(join(dir, ".tendrc.json"), JSON.stringify({ duplicationModel: "claude-opus-4-6" }));
    expect((await loadConfig(dir)).duplicationModel).toBe("claude-opus-4-6");

    const merged = applyCliOverrides(await loadConfig(dir), { duplicationModel: "claude-opus-4-7" });
    expect(merged.duplicationModel).toBe("claude-opus-4-7");
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

  it("rejects NaN overrides via schema re-validation", async () => {
    const base = await loadConfig(dir);
    expect(() => applyCliOverrides(base, { maxLoops: NaN })).toThrow();
    expect(() => applyCliOverrides(base, { maxSessions: NaN })).toThrow();
  });

  it("rejects zero and negative overrides via schema re-validation", async () => {
    const base = await loadConfig(dir);
    expect(() => applyCliOverrides(base, { maxLoops: 0 })).toThrow();
    expect(() => applyCliOverrides(base, { maxSessions: -1 })).toThrow();
  });

  it("accepts valid overrides after re-validation", async () => {
    const base = await loadConfig(dir);
    const merged = applyCliOverrides(base, { maxLoops: 3, maxSessions: 2 });
    expect(merged.maxLoops).toBe(3);
    expect(merged.maxSessions).toBe(2);
  });
});
