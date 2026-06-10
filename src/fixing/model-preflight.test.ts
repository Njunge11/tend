import { describe, expect, it } from "vitest";
import { preflightModels, type ModelPing } from "./model-preflight.js";

/** Trimmed from a real `claude -p … --output-format json` run against a valid model. */
const VALID_RESULT = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "ok",
  total_cost_usd: 0.001,
});

/** Trimmed from a real run against `claude-opus-4.6` (typo'd dot): is_error with exit 0. */
const UNKNOWN_MODEL_RESULT = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: true,
  api_error_status: 404,
  result:
    "There's an issue with the selected model (claude-opus-4.6). It may not exist or you may not have access to it. Run --model to pick a different model.",
  total_cost_usd: 0,
});

const pingWith = (responses: Record<string, { stdout: string; exitCode: number }>): ModelPing => {
  return (model) => {
    const response = responses[model];
    if (!response) throw new Error(`unexpected ping for ${model}`);
    return Promise.resolve(response);
  };
};

describe("preflightModels", () => {
  it("passes when every model's result payload is not an error", async () => {
    const ping = pingWith({
      "claude-sonnet-4-6": { stdout: VALID_RESULT, exitCode: 0 },
      "claude-opus-4-8": { stdout: VALID_RESULT, exitCode: 0 },
    });
    expect(await preflightModels(["claude-sonnet-4-6", "claude-opus-4-8"], ping)).toEqual({ ok: true });
  });

  it("fails on the exit-0 unknown-model payload and surfaces the CLI's message", async () => {
    const ping = pingWith({
      "claude-sonnet-4-6": { stdout: VALID_RESULT, exitCode: 0 },
      "claude-opus-4.6": { stdout: UNKNOWN_MODEL_RESULT, exitCode: 0 },
    });
    const result = await preflightModels(["claude-sonnet-4-6", "claude-opus-4.6"], ping);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.model).toBe("claude-opus-4.6");
      expect(result.failures[0]?.detail).toContain("claude-opus-4.6");
    }
  });

  it("pings each distinct model once", async () => {
    const pinged: string[] = [];
    const ping: ModelPing = (model) => {
      pinged.push(model);
      return Promise.resolve({ stdout: VALID_RESULT, exitCode: 0 });
    };
    await preflightModels(["m1", "m1", "m2"], ping);
    expect(pinged.sort()).toEqual(["m1", "m2"]);
  });

  it("fails when the ping itself rejects (claude binary missing, timeout)", async () => {
    const ping: ModelPing = () => Promise.reject(new Error("spawn claude ENOENT"));
    const result = await preflightModels(["claude-sonnet-4-6"], ping);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures[0]?.detail).toContain("ENOENT");
  });

  it("fails on a nonzero exit with no parseable result payload", async () => {
    const ping = pingWith({ m: { stdout: "boom", exitCode: 1 } });
    const result = await preflightModels(["m"], ping);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures[0]?.detail).toContain("exited 1");
  });

  it("fails open when output is unparseable but the CLI exited 0 (format drift must not brick runs)", async () => {
    const ping = pingWith({ m: { stdout: "some future non-json banner", exitCode: 0 } });
    expect(await preflightModels(["m"], ping)).toEqual({ ok: true });
  });

  it("finds the result payload even with noise around it", async () => {
    const ping = pingWith({
      m: { stdout: `warning: something\n${UNKNOWN_MODEL_RESULT}\ntrailing noise`, exitCode: 0 },
    });
    const result = await preflightModels(["m"], ping);
    expect(result.ok).toBe(false);
  });
});
