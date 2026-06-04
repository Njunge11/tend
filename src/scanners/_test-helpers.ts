import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ScanContext } from "./scanner.js";

export const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../test/fixtures/scanner-outputs/${name}`, import.meta.url)), "utf8");

export const ctx: ScanContext = { cwd: "/repo", files: [], loop: 1 };
