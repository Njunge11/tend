import { Command } from "commander";

export type CliHandlers = {
  run: (opts: {
    paths?: string[];
    all?: boolean;
    maxLoops?: number;
    maxSessions?: number;
    model?: string;
    effort?: string;
    includeTests?: boolean;
    plain?: boolean;
    color?: boolean;
    verbose?: boolean;
  }) => Promise<void> | void;
  diff: () => Promise<void> | void;
  undo: () => Promise<void> | void;
  show: (id: string) => Promise<void> | void;
  retry: (id: string) => Promise<void> | void;
};

/** Build the commander program wiring each subcommand to a handler. */
export function buildProgram(handlers: CliHandlers): Command {
  const program = new Command();
  program.name("tend").description("Audit a JS/TS repo and fix findings with AI in a safe loop.");
  program.exitOverride(); // throw instead of process.exit, so callers/tests can handle errors

  program
    .command("run")
    .description("snapshot → audit → fix loop → report (changed files)")
    .argument("[paths...]", "fix only findings under these files/dirs (committed or not)")
    .option("--all", "fix the entire backlog, not just changed files")
    .option("--max-loops <n>", "cap on fix loops", (v) => parseInt(v, 10))
    .option("--max-sessions <n>", "concurrent AI sessions", (v) => parseInt(v, 10))
    .option("--model <model>", "model for fixes: sonnet (default), opus, haiku, or a full model id")
    .option("--effort <level>", "reasoning effort for fixes: low | medium | high | xhigh | max")
    .option("--include-tests", "also fix findings in test files (excluded by default)")
    .option("--plain", "plain one-line-per-event output for pipes/CI (no color, no spinners)")
    .option("--no-color", "disable color output")
    .option("--verbose", "show the full per-tool / per-finding breakdown in the summary")
    .action((paths: string[], opts) => handlers.run({ ...opts, paths }));

  program.command("diff").description("show only the tool's edits").action(() => handlers.diff());
  program.command("undo").description("restore the pre-run snapshot").action(() => handlers.undo());
  program.command("show <id>").description("full detail on one finding").action((id: string) => handlers.show(id));
  program
    .command("retry <id>")
    .description("re-attempt a stubborn finding with a larger budget")
    .action((id: string) => handlers.retry(id));

  return program;
}
