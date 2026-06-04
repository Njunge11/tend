import { describe, expect, it, vi } from "vitest";
import { ClaudeSession } from "./claude.js";
import type { SessionRequest } from "./types.js";

const req: SessionRequest = { file: "src/a.ts", findings: [], prompt: "fix the findings" };

// One assistant turn that writes a file, then a success result — newline-delimited JSON.
const streamWithWrite = [
  JSON.stringify({ type: "system", subtype: "init" }),
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu_1",
          name: "Write",
          input: { file_path: "/repo/src/a.ts", content: "export const a = 2;\n" },
        },
      ],
    },
  }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    total_cost_usd: 0.0123,
    usage: {
      input_tokens: 100,
      output_tokens: 200,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 40,
    },
  }),
].join("\n");

async function runStream(stream: string, exitCode = 1) {
  const spawn = vi.fn().mockResolvedValue({ stdout: stream, exitCode });
  const session = new ClaudeSession({ spawn });
  return session.run(req);
}

describe("ClaudeSession", () => {
  it("T-070: claude impl parses stream-json → edits", async () => {
    const spawn = vi.fn().mockResolvedValue({ stdout: streamWithWrite, exitCode: 0 });
    const session = new ClaudeSession({ spawn });

    const result = await session.run(req);

    expect(result).toStrictEqual({
      ok: true,
      edits: [{ path: "/repo/src/a.ts", contents: "export const a = 2;\n" }],
      usage: {
        estimatedCostUsd: 0.0123,
        inputTokens: 100,
        outputTokens: 200,
        cacheCreationInputTokens: 30,
        cacheReadInputTokens: 40,
        sessions: 1,
      },
    });
  });

  it("T-071: session crash/error → failed-attempt result (no throw), zero usage, sessions=0", async () => {
    const spawn = vi.fn().mockRejectedValue(new Error("spawn ENOENT claude"));
    const session = new ClaudeSession({ spawn });

    const result = await session.run(req);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ENOENT");
      expect(result.rateLimited).toBe(false);
    }
    expect(result.usage).toStrictEqual({
      estimatedCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      sessions: 0,
    });
  });

  it("parses estimated cost/usage from an error result message (sessions=1)", async () => {
    const stream = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      error: "model crashed mid-run",
      total_cost_usd: 0.5,
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 },
    });
    const result = await runStream(stream);

    expect(result.ok).toBe(false);
    expect(result.usage).toStrictEqual({
      estimatedCostUsd: 0.5,
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 1,
      cacheReadInputTokens: 2,
      sessions: 1,
    });
  });

  it("T-072: rate-limit signal surfaced for backoff", async () => {
    const stream = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      error: "API rate limit exceeded (429)",
    });
    const result = await runStream(stream);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rateLimited).toBe(true);
  });
});
