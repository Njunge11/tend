import { Command } from "commander";
import { existsSync } from "node:fs";

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

const COMMAND_NAMES = new Set(["diff", "help", "retry", "run", "show", "undo"]);
const RUN_OPTION_NAMES = new Set([
  "--all",
  "--effort",
  "--include-tests",
  "--max-loops",
  "--max-sessions",
  "--model",
  "--no-color",
  "--plain",
  "--verbose",
]);

function addRunOptions(command: Command): Command {
  return command
    .option("--all", "fix the entire backlog, not just changed files")
    .option("--max-loops <n>", "cap on fix loops", (v) => parseInt(v, 10))
    .option("--max-sessions <n>", "concurrent AI sessions", (v) => parseInt(v, 10))
    .option("--model <model>", "model for fixes: sonnet (default), opus, haiku, or a full model id")
    .option("--effort <level>", "reasoning effort for fixes: low | medium | high | xhigh | max")
    .option("--include-tests", "also fix findings in test files (excluded by default)")
    .option("--plain", "plain one-line-per-event output for pipes/CI (no color, no spinners)")
    .option("--no-color", "disable color output")
    .option("--verbose", "show the full per-tool / per-finding breakdown in the summary");
}

function looksLikePath(value: string): boolean {
  return value.includes("/") || value.includes("\\") || value.startsWith(".") || existsSync(value);
}

function isRunOption(value: string): boolean {
  const name = value.split("=")[0] ?? value;
  return RUN_OPTION_NAMES.has(name);
}

function shouldInsertRun(args: string[]): boolean {
  const first = args[0];
  if (!first) return true;
  if (first === "--help" || first === "-h" || COMMAND_NAMES.has(first)) return false;
  return isRunOption(first) || looksLikePath(first);
}

function withDefaultRun(argv: readonly string[], from: "node" | "electron" | "user" | undefined): string[] {
  const prefixLength = from === "user" ? 0 : 2;
  const prefix = argv.slice(0, prefixLength);
  const args = argv.slice(prefixLength);
  return shouldInsertRun(args) ? [...prefix, "run", ...args] : [...argv];
}

function enableDefaultRun(program: Command): void {
  const parse = program.parse.bind(program);
  const parseAsync = program.parseAsync.bind(program);
  program.parse = ((argv?: readonly string[], options?: Parameters<Command["parse"]>[1]) =>
    parse(withDefaultRun(argv ?? process.argv, options?.from), options)) as Command["parse"];
  program.parseAsync = ((argv?: readonly string[], options?: Parameters<Command["parseAsync"]>[1]) =>
    parseAsync(withDefaultRun(argv ?? process.argv, options?.from), options)) as Command["parseAsync"];
}

/** Build the commander program wiring each subcommand to a handler. */
export function buildProgram(handlers: CliHandlers): Command {
  const program = new Command();
  program.name("tend").description("Audit a JS/TS repo and fix findings with AI in a safe loop.");
  program.exitOverride(); // throw instead of process.exit, so callers/tests can handle errors
  program.addHelpCommand(true);

  const run = program
    .command("run")
    .description("snapshot → audit → fix loop → report (changed files)")
    .argument("[paths...]", "fix only findings under these files/dirs (committed or not)");
  addRunOptions(run).action((paths: string[], opts) => handlers.run({ ...opts, paths }));

  program.command("diff").description("show only the tool's edits").action(() => handlers.diff());
  program.command("undo").description("restore the pre-run snapshot").action(() => handlers.undo());
  program.command("show <id>").description("full detail on one finding").action((id: string) => handlers.show(id));
  program
    .command("retry <id>")
    .description("re-attempt a stubborn finding with a larger budget")
    .action((id: string) => handlers.retry(id));

  enableDefaultRun(program);
  return program;
}
