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

  it("audit events carry the eligibility funnel (eligible + per-reason exclusions) intact", () => {
    const bus = new EventBus();
    const received: TendEvent[] = [];
    bus.on((e) => received.push(e));

    const audit: TendEvent = {
      type: "audit",
      loop: 1,
      findings: 11,
      files: 7,
      scanned: 23,
      eligible: 2,
      excluded: { tests: 8, generated: 0, fixtures: 0, outOfScope: 1, reportOnly: 0 },
    };
    bus.emit(audit);

    expect(received).toStrictEqual([audit]);
  });

  it("T-098: silent mode (no listener) → no terminal output, loop still runs", () => {
    const bus = new EventBus();
    const sink = vi.spyOn(console, "log");

    expect(() => bus.emit({ type: "audit", loop: 1, findings: 5, files: 2 })).not.toThrow();

    expect(sink).not.toHaveBeenCalled();
    sink.mockRestore();
  });
});
