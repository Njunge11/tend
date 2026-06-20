/**
 * Child-process entry for the eslint+sonarjs scan. tend forks this once (via execa's execaNode,
 * IPC enabled) and reuses it across audits — see EslintWorker in eslint-sonarjs.ts — so the heavy
 * TypeScript program that type-aware linting builds stays warm between loops while living in a
 * separate heap that never weighs on tend's.
 *
 * This file is ONLY the glue that binds execa's real IPC channel to {@link serveEslintScans}; all
 * the behaviour (read request → scan → reply, error handling, channel close) lives there and is
 * unit-tested in-process. It runs solely inside a forked subprocess, so it can't carry coverage.
 */
import { getEachMessage, sendMessage } from "execa";
import type { ScanContext } from "./scanner.js";
import { serveEslintScans } from "./eslint-sonarjs.js";

await serveEslintScans({
  requests: () => getEachMessage() as AsyncIterable<{ id: number; ctx: ScanContext }>,
  reply: (message) => sendMessage(message),
});
