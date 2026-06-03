import { describe, expect, it } from "vitest";
import { fakeSession } from "../../test/helpers/fake-session.js";
import type { FileEdit } from "../fixing/change-set.js";

describe("fakeSession (test harness)", () => {
  it("T-069: fake session returns scripted edits", async () => {
    const edits: FileEdit[] = [{ path: "/repo/src/a.ts", contents: "export const a = 2;\n" }];
    const session = fakeSession({ ok: true, edits });

    const result = await session.run({ file: "src/a.ts", findings: [], prompt: "fix it" });

    expect(result).toStrictEqual({ ok: true, edits });
    expect(session.calls).toHaveLength(1);
    expect(session.calls[0]?.file).toBe("src/a.ts");
  });
});
