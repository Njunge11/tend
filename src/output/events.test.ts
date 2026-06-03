import { describe, expect, it, vi } from "vitest";
import { EventBus, type TendEvent } from "./events.js";

describe("EventBus", () => {
  it("T-097: orchestrator emits events; reporter receives them", () => {
    const bus = new EventBus();
    const received: TendEvent[] = [];
    bus.on((e) => received.push(e));

    bus.emit({ type: "audit", loop: 1, findings: 23, files: 9 });
    bus.emit({ type: "done", exitStatus: 0 });

    expect(received).toStrictEqual([
      { type: "audit", loop: 1, findings: 23, files: 9 },
      { type: "done", exitStatus: 0 },
    ]);
  });

  it("T-098: silent mode (no listener) → no terminal output, loop still runs", () => {
    const bus = new EventBus();
    const sink = vi.spyOn(console, "log");

    expect(() => bus.emit({ type: "audit", loop: 1, findings: 5, files: 2 })).not.toThrow();

    expect(sink).not.toHaveBeenCalled();
    sink.mockRestore();
  });
});
