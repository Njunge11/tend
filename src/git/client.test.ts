import { afterEach, describe, expect, it } from "vitest";
import { gitEnv } from "./client.js";

const UNSAFE_KEYS = [
  "EDITOR",
  "VISUAL",
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "GIT_PAGER",
  "PAGER",
] as const;

describe("gitEnv", () => {
  const previous = new Map<string, string | undefined>();

  afterEach(() => {
    for (const key of [...UNSAFE_KEYS, "TEND_SAFE_ENV", "TEND_OVERRIDE"]) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    previous.clear();
  });

  function setEnv(key: string, value: string): void {
    if (!previous.has(key)) previous.set(key, process.env[key]);
    process.env[key] = value;
  }

  it("removes unsafe editor and pager variables while preserving safe env and overrides", () => {
    for (const key of UNSAFE_KEYS) setEnv(key, `unsafe-${key}`);
    setEnv("TEND_SAFE_ENV", "from-process");
    setEnv("TEND_OVERRIDE", "from-process");

    const env = gitEnv({
      TEND_OVERRIDE: "from-extra",
      GIT_INDEX_FILE: "/tmp/tend-index",
      EDITOR: "unsafe-extra-editor",
    });

    for (const key of UNSAFE_KEYS) {
      expect(env).not.toHaveProperty(key);
    }
    expect(env.TEND_SAFE_ENV).toBe("from-process");
    expect(env.TEND_OVERRIDE).toBe("from-extra");
    expect(env.GIT_INDEX_FILE).toBe("/tmp/tend-index");
  });
});
