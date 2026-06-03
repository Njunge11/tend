import { normalize, type RawFinding } from "../../src/findings/normalize.js";
import type { Finding } from "../../src/findings/finding.js";

const DEFAULT_RAW: RawFinding = {
  tool: "sonarjs",
  rule: "no-identical-expressions",
  category: "bug",
  severity: "error",
  file: "src/a.ts",
  range: { startLine: 1, startCol: 0, endLine: 1, endCol: 10 },
  message: "Identical sub-expressions",
};

/** Build a normalized Finding for tests; override any raw field, set the loop. */
export function makeFinding(overrides: Partial<RawFinding> = {}, loop = 1): Finding {
  return normalize({ ...DEFAULT_RAW, ...overrides }, loop);
}
