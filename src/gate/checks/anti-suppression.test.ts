import { describe, expect, it } from "vitest";
import { antiSuppression } from "./anti-suppression.js";

// Minimal unified-diff-ish strings: '+' added, '-' removed, ' ' context.
describe("antiSuppression", () => {
  it("T-038: reject — diff adds eslint-disable", () => {
    const diff = ["+// eslint-disable-next-line no-eval", " eval(input);"].join("\n");
    const r = antiSuppression(diff);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("suppression");
  });

  it("T-039: reject — diff adds @ts-ignore / @ts-nocheck", () => {
    expect(antiSuppression("+// @ts-ignore\n const x = y;").ok).toBe(false);
    expect(antiSuppression("+// @ts-nocheck").ok).toBe(false);
  });

  it("T-040: reject — diff adds a cast to any", () => {
    expect(antiSuppression("+const x = val as any;").ok).toBe(false);
    expect(antiSuppression("+function f(x: any) {}").ok).toBe(false);
  });

  it("T-041: reject — code deleted instead of fixed", () => {
    const diff = ["-function brokenButReal() {", "-  return compute();", "-}"].join("\n");
    const r = antiSuppression(diff);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("suppression");
  });

  it("allows delete-only diffs when explicitly requested", () => {
    const diff = ["-function unusedHelper() {", "-  return compute();", "-}"].join("\n");
    expect(antiSuppression(diff, { allowDeleteOnly: true })).toStrictEqual({ ok: true });
  });

  it("still rejects added suppressions when delete-only diffs are allowed", () => {
    const diff = ["-const x = before;", "+// @ts-ignore", "+const x = after;"].join("\n");
    const r = antiSuppression(diff, { allowDeleteOnly: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toBe("Fix added @ts-ignore");
  });

  it("T-042: happy — a legitimate fix passes", () => {
    const diff = ["-  return a == b;", "+  return a === b;"].join("\n");
    expect(antiSuppression(diff)).toStrictEqual({ ok: true });
  });

  it("T-043: edge — cast to unknown is allowed (not any)", () => {
    expect(antiSuppression("+const x = val as unknown as Foo;").ok).toBe(true);
  });

  it("T-044: edge — a pre-existing disable comment left untouched is not flagged", () => {
    // context line (no +/-) carrying an old disable comment must not trip the check
    const diff = [" // eslint-disable-next-line no-eval", "-const x = 1;", "+const x = 2;"].join("\n");
    expect(antiSuppression(diff).ok).toBe(true);
  });
});
