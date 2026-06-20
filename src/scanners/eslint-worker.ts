/**
 * Persistent child-process entry for the eslint+sonarjs scan. tend forks this ONCE (via execa's
 * `execaNode`, IPC enabled) and reuses it across audits — see EslintWorker in eslint-sonarjs.ts —
 * so the heavy TypeScript program that type-aware linting builds (projectService) stays warm
 * between loops, yet lives in a separate process whose own heap never weighs on tend's and which
 * execa reclaims on disposal / when tend exits.
 *
 * Protocol (execa IPC): the parent sends `{ id, ctx }`; this replies `{ id, result }` or
 * `{ id, error }`. `getEachMessage()` yields requests until the parent closes the channel, at which
 * point the loop ends and this process exits.
 */
import { getEachMessage, sendMessage } from "execa";
import { runEslintSonarjsInProcess } from "./eslint-sonarjs.js";
import type { ScanContext } from "./scanner.js";

type ScanRequest = { id: number; ctx: ScanContext };

for await (const message of getEachMessage()) {
  const { id, ctx } = message as ScanRequest;
  try {
    const result = await runEslintSonarjsInProcess(ctx);
    await sendMessage({ id, result });
  } catch (err) {
    await sendMessage({ id, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
  }
}
