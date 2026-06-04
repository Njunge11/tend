import { describe, expect, it } from "vitest";
import { parseStreamJson } from "./stream-json.js";

const resultLine = (extra: Record<string, unknown>): string =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, ...extra });

describe("parseStreamJson — usage/cost", () => {
  it("parses total_cost_usd and token usage from a success result message", () => {
    const raw = resultLine({
      total_cost_usd: 1.23,
      usage: {
        input_tokens: 500,
        output_tokens: 250,
        cache_creation_input_tokens: 60,
        cache_read_input_tokens: 40,
      },
    });

    expect(parseStreamJson(raw).usage).toStrictEqual({
      estimatedCostUsd: 1.23,
      inputTokens: 500,
      outputTokens: 250,
      cacheCreationInputTokens: 60,
      cacheReadInputTokens: 40,
    });
  });

  it("parses usage/cost from an error result message too", () => {
    const raw = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      error: "boom",
      total_cost_usd: 0.4,
      usage: { input_tokens: 12, output_tokens: 8 },
    });

    const parsed = parseStreamJson(raw);
    expect(parsed.errored).toBe(true);
    expect(parsed.usage.estimatedCostUsd).toBe(0.4);
    expect(parsed.usage.inputTokens).toBe(12);
    expect(parsed.usage.outputTokens).toBe(8);
    // missing token fields default to 0
    expect(parsed.usage.cacheCreationInputTokens).toBe(0);
    expect(parsed.usage.cacheReadInputTokens).toBe(0);
  });

  it("accepts cost_usd / costUSD field spellings", () => {
    expect(parseStreamJson(resultLine({ cost_usd: 2.5 })).usage.estimatedCostUsd).toBe(2.5);
    expect(parseStreamJson(resultLine({ costUSD: 3.5 })).usage.estimatedCostUsd).toBe(3.5);
  });

  it("prefers the last non-null cost/usage across multiple result messages", () => {
    const raw = [
      resultLine({ total_cost_usd: 1.0, usage: { input_tokens: 10 } }),
      resultLine({ total_cost_usd: 2.0, usage: { input_tokens: 20 } }),
      // a trailing result with no cost/usage must not clobber the prior one
      resultLine({}),
    ].join("\n");

    const usage = parseStreamJson(raw).usage;
    expect(usage.estimatedCostUsd).toBe(2.0);
    expect(usage.inputTokens).toBe(20);
  });

  it("defaults to zero usage when no result message carries cost/usage", () => {
    const raw = JSON.stringify({ type: "system", subtype: "init" });
    expect(parseStreamJson(raw).usage).toStrictEqual({
      estimatedCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
  });

  it("skips malformed/non-JSON lines without losing usage parsing", () => {
    const raw = [
      "not json at all",
      "{ broken json",
      resultLine({ total_cost_usd: 0.99, usage: { output_tokens: 7 } }),
      "trailing garbage",
    ].join("\n");

    const usage = parseStreamJson(raw).usage;
    expect(usage.estimatedCostUsd).toBe(0.99);
    expect(usage.outputTokens).toBe(7);
  });
});
