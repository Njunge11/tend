import { existsSync } from "node:fs";
import { join } from "node:path";

/** TS mode when a tsconfig is present; otherwise JS mode. */
export function detectTypeScript(cwd: string): boolean {
  return existsSync(join(cwd, "tsconfig.json"));
}
