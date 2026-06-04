import { describe, expect, it, vi } from "vitest";
import { buildProgram, type CliHandlers } from "./cli.js";

function handlers(overrides: Partial<CliHandlers> = {}): CliHandlers {
  return {
    run: vi.fn(),
    diff: vi.fn(),
    undo: vi.fn(),
    show: vi.fn(),
    retry: vi.fn(),
    ...overrides,
  };
}

describe("buildProgram", () => {
  it("T-116: cli parses args/flags → dispatches the right command", async () => {
    const h = handlers();
    const program = buildProgram(h);

    await program.parseAsync(["run", "--all", "--max-loops", "2", "--max-sessions", "8"], { from: "user" });

    expect(h.run).toHaveBeenCalledOnce();
    expect(h.run).toHaveBeenCalledWith(expect.objectContaining({ all: true, maxLoops: 2, maxSessions: 8 }));
    expect(h.diff).not.toHaveBeenCalled();
  });

  it("parses --model and passes it to the run handler", async () => {
    const h = handlers();
    await buildProgram(h).parseAsync(["run", "--model", "opus"], { from: "user" });
    expect(h.run).toHaveBeenCalledWith(expect.objectContaining({ model: "opus" }));
  });

  it("parses --effort and passes it to the run handler", async () => {
    const h = handlers();
    await buildProgram(h).parseAsync(["run", "--effort", "high"], { from: "user" });
    expect(h.run).toHaveBeenCalledWith(expect.objectContaining({ effort: "high" }));
  });

  it("parses --include-tests and passes it to the run handler", async () => {
    const h = handlers();
    await buildProgram(h).parseAsync(["run", "--include-tests"], { from: "user" });
    expect(h.run).toHaveBeenCalledWith(expect.objectContaining({ includeTests: true }));
  });

  it("T-123: parses run <path...> positionals into opts.paths", async () => {
    const h = handlers();
    await buildProgram(h).parseAsync(
      ["run", "apps/dashboard/lib/whatsapp", "src/a.ts"],
      { from: "user" },
    );
    expect(h.run).toHaveBeenCalledWith(
      expect.objectContaining({
        paths: ["apps/dashboard/lib/whatsapp", "src/a.ts"],
      }),
    );
  });

  it("run with no positionals leaves paths empty", async () => {
    const h = handlers();
    await buildProgram(h).parseAsync(["run"], { from: "user" });
    expect(h.run).toHaveBeenCalledWith(
      expect.objectContaining({ paths: [] }),
    );
  });

  it("T-116: show <id> passes the id through", async () => {
    const h = handlers();
    await buildProgram(h).parseAsync(["show", "abc123"], { from: "user" });
    expect(h.show).toHaveBeenCalledWith("abc123");
  });

  it("retry <id> passes the id through", async () => {
    const h = handlers();
    await buildProgram(h).parseAsync(["retry", "abc123"], { from: "user" });
    expect(h.retry).toHaveBeenCalledWith("abc123");
  });

  it("T-117: unknown command → help/error", async () => {
    const program = buildProgram(handlers());
    await expect(program.parseAsync(["bogus"], { from: "user" })).rejects.toThrow();
  });
});
