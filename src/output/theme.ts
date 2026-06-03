import { Chalk, type ChalkInstance, supportsColor } from "chalk";
import gradient from "gradient-string";
import type { OutputEnv } from "./env.js";

/**
 * The visual language. Restraint is the point: one accent color used for ~2 things (the
 * wordmark + the active spinner), muted semantic colors for outcomes, everything else
 * achromatic. Hierarchy comes from indentation + dim metadata, not from color.
 */
export type Theme = {
  /** The single accent — wordmark + active spinner only. */
  accent: Style;
  /** Soft green — a fix that landed. */
  fixed: Style;
  /** Soft amber — a fix that was reverted. */
  reverted: Style;
  /** Soft red — an error / something that needs the human. */
  error: Style;
  /** Dim grey — metadata, queued, rules, hints. */
  dim: Style;
  bold: Style;
  plain: Style;
  /** The "t e n d" wordmark: a subtle gradient when truecolor is available, else flat. */
  wordmark: () => string;
  glyph: Glyphs;
};

export type Style = (s: string) => string;

export type Glyphs = {
  fixed: string;
  reverted: string;
  left: string;
  scanned: string;
  bullet: string;
  rule: string;
  arrow: string;
  spinner: string[];
};

// Muted, never-saturated palette. Tuned to read on both light and dark backgrounds; chalk
// downsamples these hexes to ANSI-256 / 16-color automatically on lesser terminals.
const PALETTE = {
  accent: "#7AA2F7", // calm periwinkle blue
  accentTo: "#9D7CD8", // → soft violet, for the wordmark gradient
  green: "#9ECE6A", // soft green
  amber: "#E0AF68", // soft amber
  red: "#E88388", // soft red (per spec)
};

const UNICODE_GLYPHS: Glyphs = {
  fixed: "✔",
  reverted: "↩",
  left: "–",
  scanned: "✔",
  bullet: "·",
  rule: "─",
  arrow: "→",
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};

const ASCII_GLYPHS: Glyphs = {
  fixed: "+",
  reverted: "<",
  left: "-",
  scanned: "+",
  bullet: "·",
  rule: "-",
  arrow: ">",
  spinner: ["-", "\\", "|", "/"],
};

/** Resolve the chalk color level: 0 (off) when color is disabled, else the terminal's. */
function chalkLevel(env: OutputEnv): 0 | 1 | 2 | 3 {
  if (!env.color) return 0;
  const detected = supportsColor ? supportsColor.level : 0;
  // Color is enabled (e.g. FORCE_COLOR / TTY) but detection came back 0 → assume basic 16.
  return (detected > 0 ? detected : 1) as 1 | 2 | 3;
}

export function makeTheme(env: OutputEnv): Theme {
  const c: ChalkInstance = new Chalk({ level: chalkLevel(env) });
  const glyph = env.unicode ? UNICODE_GLYPHS : ASCII_GLYPHS;

  const accent: Style = (s) => c.hex(PALETTE.accent)(s);
  const wordmark = (): string => {
    if (!env.color) return "tend";
    // Truecolor → a real gradient; lesser terminals → flat accent (gradient escapes would
    // posterize badly on 16/256-color).
    if (c.level >= 3) return gradient([PALETTE.accent, PALETTE.accentTo])("tend");
    return accent("tend");
  };

  return {
    accent,
    fixed: (s) => c.hex(PALETTE.green)(s),
    reverted: (s) => c.hex(PALETTE.amber)(s),
    error: (s) => c.hex(PALETTE.red)(s),
    dim: (s) => c.dim(s),
    bold: (s) => c.bold(s),
    plain: (s) => s,
    wordmark,
    glyph,
  };
}
