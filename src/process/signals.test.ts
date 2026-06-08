import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { onTerminationSignals } from "./signals.js";

describe("onTerminationSignals", () => {
  it("invokes the handler with the signal name on SIGINT and SIGTERM", () => {
    const bus = new EventEmitter();
    const handler = vi.fn();
    onTerminationSignals(handler, bus);

    bus.emit("SIGINT");
    bus.emit("SIGTERM");

    expect(handler).toHaveBeenCalledWith("SIGINT");
    expect(handler).toHaveBeenCalledWith("SIGTERM");
  });

  it("stops invoking the handler once unregistered", () => {
    const bus = new EventEmitter();
    const handler = vi.fn();
    const off = onTerminationSignals(handler, bus);

    off();
    bus.emit("SIGINT");
    bus.emit("SIGTERM");

    expect(handler).not.toHaveBeenCalled();
  });

  it("fires at most once per signal (terminate-then-exit, no double teardown)", () => {
    const bus = new EventEmitter();
    const handler = vi.fn();
    onTerminationSignals(handler, bus);

    bus.emit("SIGINT");
    bus.emit("SIGINT");

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
