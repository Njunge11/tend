/**
 * Output environment detection — the single source of truth for "may we use color?"
 * and "may we redraw the screen?". Pure and injectable so the rules are testable without
 * a real terminal. Follows clig.dev: honor NO_COLOR, TERM=dumb, non-TTY, and CI.
 */

export type OutputEnv = {
  /** Emit ANSI color escapes. */
  color: boolean;
  /** Use spinners / redrawing (a live TTY). Off for pipes, CI, dumb terminals, --plain. */
  interactive: boolean;
  /** Terminal can render unicode glyphs (✔ ↩ …) rather than ASCII fallbacks. */
  unicode: boolean;
};

type DetectInput = {
  /** The stream we render to (defaults are derived from `process.stdout` by callers). */
  stream?: { isTTY?: boolean };
  env?: NodeJS.ProcessEnv;
  /** `--no-color` flag. */
  noColor?: boolean;
  /** `--plain` flag: machine/pipe consumption — no color, no redraw. */
  plain?: boolean;
  platform?: NodeJS.Platform;
};

/** Truthy in the env-var sense: present and not an explicit off value. */
function flagOn(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

function isCI(env: NodeJS.ProcessEnv): boolean {
  // Most CI providers set CI; some set their own. Any of them means "not a live terminal".
  return flagOn(env.CI) || flagOn(env.CONTINUOUS_INTEGRATION) || env.GITHUB_ACTIONS !== undefined;
}

function unicodeSupported(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return true;
  // Modern Windows terminals advertise themselves; legacy cmd.exe does not.
  return Boolean(env.WT_SESSION) || env.TERM_PROGRAM === "vscode" || env.TERM === "xterm-256color";
}

/**
 * Resolve color + interactivity from the environment and flags.
 *
 * Color is disabled when stdout is not a TTY, NO_COLOR is set, TERM=dumb, --no-color,
 * TEND_NO_COLOR, or --plain. FORCE_COLOR re-enables it for a non-TTY (but never overrides
 * an explicit opt-out). Interactivity additionally requires not being in CI.
 */
export function detectOutputEnv(input: DetectInput = {}): OutputEnv {
  const env = input.env ?? {};
  const platform = input.platform ?? "linux";
  const isTTY = Boolean(input.stream?.isTTY);

  const explicitlyOff =
    input.noColor === true ||
    input.plain === true ||
    "NO_COLOR" in env ||
    flagOn(env.TEND_NO_COLOR) ||
    env.TERM === "dumb";

  const forced = !explicitlyOff && flagOn(env.FORCE_COLOR);
  const color = !explicitlyOff && (isTTY || forced);

  const interactive = isTTY && !input.plain && env.TERM !== "dumb" && !isCI(env);

  return { color, interactive, unicode: unicodeSupported(env, platform) };
}
