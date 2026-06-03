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
  JSON.stringify({ type: "result", subtype: "success", is_error: false }),
].join("\n");

describe("ClaudeSession", () => {
  it("T-070: claude impl parses stream-json → edits", async () => {
    const spawn = vi.fn().mockResolvedValue({ stdout: streamWithWrite, exitCode: 0 });
    const session = new ClaudeSession({ spawn });

    const result = await session.run(req);

    expect(result).toStrictEqual({
      ok: true,
      edits: [{ path: "/repo/src/a.ts", contents: "export const a = 2;\n" }],
    });
  });

  it("T-071: session crash/error → failed-attempt result (no throw)", async () => {
    const spawn = vi.fn().mockRejectedValue(new Error("spawn ENOENT claude"));
    const session = new ClaudeSession({ spawn });

    const result = await session.run(req);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ENOENT");
      expect(result.rateLimited).toBe(false);
    }
  });

  it("T-072: rate-limit signal surfaced for backoff", async () => {
    const stream = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      error: "API rate limit exceeded (429)",
    });
    const spawn = vi.fn().mockResolvedValue({ stdout: stream, exitCode: 1 });
    const session = new ClaudeSession({ spawn });

    const result = await session.run(req);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rateLimited).toBe(true);
  });
});
