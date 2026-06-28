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

describe("parseStreamJson — non-retryable errors", () => {
  it("flags a prompt-too-long error as non-retryable (and errored)", () => {
    const parsed = parseStreamJson(
      JSON.stringify({ type: "result", is_error: true, error: "API Error: 400 prompt is too long: 250000 tokens > 200000" }),
    );
    expect(parsed.nonRetryable).toBe(true);
    expect(parsed.errored).toBe(true);
    expect(parsed.rateLimited).toBe(false);
  });

  it("flags a max-tokens stop_reason as non-retryable even without an is_error flag", () => {
    const parsed = parseStreamJson(
      JSON.stringify({ type: "assistant", message: { stop_reason: "max_tokens", content: [] } }),
    );
    expect(parsed.nonRetryable).toBe(true);
    expect(parsed.errored).toBe(true);
  });

  it("flags a mid-run model 404 as non-retryable", () => {
    const parsed = parseStreamJson(
      JSON.stringify({ type: "result", is_error: true, error: "API Error: 404 model: claude-x not found" }),
    );
    expect(parsed.nonRetryable).toBe(true);
  });

  it("does NOT flag a rate-limit/overloaded error as non-retryable (it stays retryable)", () => {
    const parsed = parseStreamJson(
      JSON.stringify({ type: "result", is_error: true, error: "API Error: 429 rate limit exceeded, overloaded" }),
    );
    expect(parsed.rateLimited).toBe(true);
    expect(parsed.nonRetryable).toBe(false);
  });

  it("does NOT flag a generic execution error as non-retryable (keeps its retry budget)", () => {
    const parsed = parseStreamJson(
      JSON.stringify({ type: "result", is_error: true, error: "tool execution failed unexpectedly" }),
    );
    expect(parsed.errored).toBe(true);
    expect(parsed.nonRetryable).toBe(false);
  });
});
