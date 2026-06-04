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

function program(h: CliHandlers) {
  return buildProgram(h).configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
}

describe("buildProgram", () => {
  it("root with no args dispatches run with empty paths", async () => {
    const h = handlers();
    await program(h).parseAsync([], { from: "user" });
    expect(h.run).toHaveBeenCalledWith(expect.objectContaining({ paths: [] }));
  });

  it("root paths dispatch run with those paths", async () => {
    const h = handlers();
    await program(h).parseAsync(["src/scanners"], { from: "user" });
    expect(h.run).toHaveBeenCalledWith(expect.objectContaining({ paths: ["src/scanners"] }));
  });

  it("root accepts multiple paths", async () => {
    const h = handlers();
    await program(h).parseAsync(["src/scanners", "src/commands"], { from: "user" });
    expect(h.run).toHaveBeenCalledWith(
      expect.objectContaining({ paths: ["src/scanners", "src/commands"] }),
    );
  });

  it("root flags dispatch run with options", async () => {
    const h = handlers();
    await program(h).parseAsync(["--all", "--max-loops", "2"], { from: "user" });
    expect(h.run).toHaveBeenCalledWith(expect.objectContaining({ all: true, maxLoops: 2, paths: [] }));
  });

  it("root accepts flags before path args", async () => {
    const h = handlers();
    await program(h).parseAsync(["--max-loops", "2", "src/scanners"], { from: "user" });
    expect(h.run).toHaveBeenCalledWith(expect.objectContaining({ maxLoops: 2, paths: ["src/scanners"] }));
  });

  it("root accepts flags after path args", async () => {
    const h = handlers();
    await program(h).parseAsync(["src/scanners", "--plain"], { from: "user" });
    expect(h.run).toHaveBeenCalledWith(expect.objectContaining({ plain: true, paths: ["src/scanners"] }));
  });

  it("T-116: cli parses args/flags → dispatches the right command", async () => {
    const h = handlers();
    const p = program(h);

    await p.parseAsync(["run", "--all", "--max-loops", "2", "--max-sessions", "8"], { from: "user" });

    expect(h.run).toHaveBeenCalledOnce();
    expect(h.run).toHaveBeenCalledWith(expect.objectContaining({ all: true, maxLoops: 2, maxSessions: 8 }));
    expect(h.diff).not.toHaveBeenCalled();
  });

  it("parses --model and passes it to the run handler", async () => {
    const h = handlers();
    await program(h).parseAsync(["run", "--model", "opus"], { from: "user" });
    expect(h.run).toHaveBeenCalledWith(expect.objectContaining({ model: "opus" }));
  });

  it("parses --effort and passes it to the run handler", async () => {
    const h = handlers();
    await program(h).parseAsync(["run", "--effort", "high"], { from: "user" });
    expect(h.run).toHaveBeenCalledWith(expect.objectContaining({ effort: "high" }));
  });

  it("parses --include-tests and passes it to the run handler", async () => {
    const h = handlers();
    await program(h).parseAsync(["run", "--include-tests"], { from: "user" });
    expect(h.run).toHaveBeenCalledWith(expect.objectContaining({ includeTests: true }));
  });

  it("T-123: parses run <path...> positionals into opts.paths", async () => {
    const h = handlers();
    await program(h).parseAsync(
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
    await program(h).parseAsync(["run"], { from: "user" });
    expect(h.run).toHaveBeenCalledWith(
      expect.objectContaining({ paths: [] }),
    );
  });

  it("run --all still dispatches the run subcommand", async () => {
    const h = handlers();
    await program(h).parseAsync(["run", "--all"], { from: "user" });
    expect(h.run).toHaveBeenCalledWith(expect.objectContaining({ all: true, paths: [] }));
  });

  it("diff dispatches diff instead of treating it as a path", async () => {
    const h = handlers();
    await program(h).parseAsync(["diff"], { from: "user" });
    expect(h.diff).toHaveBeenCalledOnce();
    expect(h.run).not.toHaveBeenCalled();
  });

  it("undo dispatches undo instead of treating it as a path", async () => {
    const h = handlers();
    await program(h).parseAsync(["undo"], { from: "user" });
    expect(h.undo).toHaveBeenCalledOnce();
    expect(h.run).not.toHaveBeenCalled();
  });

  it("T-116: show <id> passes the id through", async () => {
    const h = handlers();
    await program(h).parseAsync(["show", "abc123"], { from: "user" });
    expect(h.show).toHaveBeenCalledWith("abc123");
    expect(h.run).not.toHaveBeenCalled();
  });

  it("retry <id> passes the id through", async () => {
    const h = handlers();
    await program(h).parseAsync(["retry", "abc123"], { from: "user" });
    expect(h.retry).toHaveBeenCalledWith("abc123");
    expect(h.run).not.toHaveBeenCalled();
  });

  it("T-117: unknown command → help/error", async () => {
    const h = handlers();
    await expect(program(h).parseAsync(["definitely-not-a-tend-command"], { from: "user" })).rejects.toThrow(
      "unknown command",
    );
    expect(h.run).not.toHaveBeenCalled();
  });

  it("reserved commands missing required args are not treated as paths", async () => {
    const h = handlers();
    await expect(program(h).parseAsync(["show"], { from: "user" })).rejects.toThrow();
    expect(h.run).not.toHaveBeenCalled();
  });

  it("help is not treated as a path", async () => {
    const h = handlers();
    await expect(program(h).parseAsync(["help"], { from: "user" })).rejects.toMatchObject({
      name: "CommanderError",
      exitCode: 0,
    });
    expect(h.run).not.toHaveBeenCalled();
  });
});
