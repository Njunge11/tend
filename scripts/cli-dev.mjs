#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();

const spawnOptions = {
  stdio: "inherit",
  shell: process.platform === "win32",
};

const pnpmBin = resolve(
  dirname(process.execPath),
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
);
const build = spawnSync(pnpmBin, ["build"], spawnOptions);
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const cli = spawnSync(process.execPath, ["dist/bin.js", ...args], spawnOptions);
process.exit(cli.status ?? 1);
