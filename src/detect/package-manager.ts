import { existsSync } from "node:fs";
import { join } from "node:path";

export type PackageManager = "pnpm" | "yarn" | "bun" | "npm";

const LOCKFILES: { file: string; pm: PackageManager }[] = [
  { file: "pnpm-lock.yaml", pm: "pnpm" },
  { file: "yarn.lock", pm: "yarn" },
  { file: "bun.lockb", pm: "bun" },
  { file: "bun.lock", pm: "bun" },
  { file: "package-lock.json", pm: "npm" },
];

/** Detect the package manager from the lockfile present; defaults to npm. */
export function detectPackageManager(cwd: string): PackageManager {
  for (const { file, pm } of LOCKFILES) {
    if (existsSync(join(cwd, file))) return pm;
  }
  return "npm";
}
