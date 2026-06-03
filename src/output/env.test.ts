import { describe, expect, it } from "vitest";
import { detectOutputEnv } from "./env.js";

const tty = { isTTY: true };
const pipe = { isTTY: false };

describe("detectOutputEnv", () => {
  it("interactive TTY with a normal terminal → color + redraw on", () => {
    const e = detectOutputEnv({ stream: tty, env: { TERM: "xterm-256color" } });
    expect(e.color).toBe(true);
    expect(e.interactive).toBe(true);
  });

  it("non-TTY (piped) → no color, no redraw", () => {
    const e = detectOutputEnv({ stream: pipe, env: {} });
    expect(e.color).toBe(false);
    expect(e.interactive).toBe(false);
  });

  it("NO_COLOR disables color even on a TTY (presence is enough, per no-color.org)", () => {
    expect(detectOutputEnv({ stream: tty, env: { NO_COLOR: "" } }).color).toBe(false);
    expect(detectOutputEnv({ stream: tty, env: { NO_COLOR: "1" } }).color).toBe(false);
  });

  it("TERM=dumb disables both color and redraw", () => {
    const e = detectOutputEnv({ stream: tty, env: { TERM: "dumb" } });
    expect(e.color).toBe(false);
    expect(e.interactive).toBe(false);
  });

  it("--no-color disables color but a TTY stays interactive (spinners, no color)", () => {
    const e = detectOutputEnv({ stream: tty, env: {}, noColor: true });
    expect(e.color).toBe(false);
    expect(e.interactive).toBe(true);
  });

  it("TEND_NO_COLOR disables color", () => {
    expect(detectOutputEnv({ stream: tty, env: { TEND_NO_COLOR: "1" } }).color).toBe(false);
  });

  it("--plain disables both color and redraw", () => {
    const e = detectOutputEnv({ stream: tty, env: {}, plain: true });
    expect(e.color).toBe(false);
    expect(e.interactive).toBe(false);
  });

  it("CI is non-interactive even on a TTY (no redraw), color still allowed", () => {
    const e = detectOutputEnv({ stream: tty, env: { CI: "true", TERM: "xterm-256color" } });
    expect(e.interactive).toBe(false);
    expect(e.color).toBe(true);
  });

  it("FORCE_COLOR re-enables color for a non-TTY, but not redraw", () => {
    const e = detectOutputEnv({ stream: pipe, env: { FORCE_COLOR: "1" } });
    expect(e.color).toBe(true);
    expect(e.interactive).toBe(false);
  });

  it("NO_COLOR wins over FORCE_COLOR", () => {
    expect(detectOutputEnv({ stream: tty, env: { FORCE_COLOR: "1", NO_COLOR: "1" } }).color).toBe(false);
  });

  it("unicode: off for legacy Windows cmd, on elsewhere", () => {
    expect(detectOutputEnv({ stream: tty, env: {}, platform: "win32" }).unicode).toBe(false);
    expect(detectOutputEnv({ stream: tty, env: { WT_SESSION: "1" }, platform: "win32" }).unicode).toBe(true);
    expect(detectOutputEnv({ stream: tty, env: {}, platform: "darwin" }).unicode).toBe(true);
  });
});
