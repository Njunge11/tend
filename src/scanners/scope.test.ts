import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeFinding } from "../../test/helpers/make-finding.js";
import { tmpRepo, type TmpRepo } from "../../test/helpers/tmp-repo.js";
import { changedFiles, filterToChanged, scopeFindings } from "./scope.js";

describe("scope — git changed files", () => {
  let repo: TmpRepo;
  beforeEach(async () => {
    repo = await tmpRepo();
  });
  afterEach(() => repo.cleanup());

  it("T-033: returns files changed vs HEAD (tracked edits + untracked)", async () => {
    repo.write("src/a.ts", "export const a = 1;\n");
    repo.write("src/keep.ts", "export const k = 1;\n");
    await repo.commit("init");

    repo.write("src/a.ts", "export const a = 2;\n"); // modify tracked
    repo.write("src/new.ts", "export const n = 1;\n"); // untracked

    const changed = await changedFiles(repo.git);

    expect(new Set(changed)).toStrictEqual(new Set(["src/a.ts", "src/new.ts"]));
  });

  it("T-037: clean tree → empty changed set → nothing dispatched", async () => {
    repo.write("src/a.ts", "export const a = 1;\n");
    await repo.commit("init");

    const changed = await changedFiles(repo.git);
    const findings = [makeFinding({ file: "src/a.ts" })];

    expect(changed).toStrictEqual([]);
    expect(scopeFindings(findings, { all: false, changed })).toStrictEqual([]);
  });
});

describe("scope — filtering", () => {
  const onChanged = makeFinding({ file: "src/a.ts" });
  const onUnchanged = makeFinding({ file: "src/legacy.ts" });
  const changed = ["src/a.ts"];

  it("T-034: filters a finding set down to changed files", () => {
    expect(filterToChanged([onChanged, onUnchanged], changed)).toStrictEqual([onChanged]);
  });

  it("T-035: --all → no filtering", () => {
    expect(scopeFindings([onChanged, onUnchanged], { all: true, changed })).toStrictEqual([
      onChanged,
      onUnchanged,
    ]);
  });

  it("T-134: a duplication clone is kept when EITHER paired file is changed", () => {
    // jscpd records only the first file as `.file`; the second clone site lives on flowPath.
    const cloneOnSecond = {
      ...makeFinding({ tool: "jscpd", rule: "duplicate-code", category: "duplication", file: "src/legacy.ts" }),
      flowPath: [
        { file: "src/legacy.ts", line: 10 },
        { file: "src/a.ts", line: 45 },
      ],
    };
    // changed set only contains the SECOND file (src/a.ts) → still kept
    expect(filterToChanged([cloneOnSecond], changed)).toStrictEqual([cloneOnSecond]);

    // neither side changed → dropped
    const cloneOffScope = {
      ...cloneOnSecond,
      flowPath: [
        { file: "src/legacy.ts", line: 10 },
        { file: "src/other.ts", line: 45 },
      ],
    };
    expect(filterToChanged([cloneOffScope], changed)).toStrictEqual([]);
  });

  it("T-036: whole-repo tools scanned wide, findings then filtered to changed", () => {
    // knip/jscpd scan the whole repo; a finding on an unchanged file is dropped by default
    const knipWide = [
      makeFinding({ tool: "knip", rule: "unused-export", category: "dead-code", file: "src/a.ts" }),
      makeFinding({ tool: "knip", rule: "unused-export", category: "dead-code", file: "src/legacy.ts" }),
    ];
    const scoped = scopeFindings(knipWide, { all: false, changed });
    expect(scoped.map((f) => f.file)).toStrictEqual(["src/a.ts"]);
  });
});
