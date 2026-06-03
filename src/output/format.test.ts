import { describe, expect, it } from "vitest";
import { formatClock, formatDuration, reasonLabel } from "./format.js";

describe("formatDuration", () => {
  it("renders sub-minute as tenths of a second", () => {
    expect(formatDuration(2400)).toBe("2.4s");
    expect(formatDuration(500)).toBe("0.5s");
  });

  it("renders a minute or more as Mm Ss", () => {
    expect(formatDuration(192_000)).toBe("3m 12s");
    expect(formatDuration(60_000)).toBe("1m 0s");
  });

  it("never prints 60 seconds (carries into the minute)", () => {
    expect(formatDuration(119_600)).toBe("2m 0s");
  });
});

describe("formatClock", () => {
  it("renders M:SS with zero-padded seconds", () => {
    expect(formatClock(42_000)).toBe("0:42");
    expect(formatClock(65_000)).toBe("1:05");
    expect(formatClock(0)).toBe("0:00");
  });
});

describe("reasonLabel", () => {
  it("maps revert reasons to plain language", () => {
    expect(reasonLabel("broke-test")).toBe("broke tests");
    expect(reasonLabel("typecheck")).toBe("broke typecheck");
    expect(reasonLabel("session-error")).toBe("the fix session failed");
    expect(reasonLabel(undefined)).toBe("couldn't fix");
  });
});
