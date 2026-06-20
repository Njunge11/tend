// A controllable stand-in for the real eslint worker, used by EslintWorker pool tests. It speaks
// the same execa-IPC contract ({ id, ctx } in → { id, result | error } out) but its behaviour is
// driven by ctx.scanId, so tests can exercise reuse, crashes, error replies, and disposal without
// depending on ESLint. NOT a test file and not bundled — invoked only via execaNode by the tests.
import { getEachMessage, sendMessage } from "execa";

for await (const message of getEachMessage()) {
  const { id, ctx } = message;
  const command = ctx?.scanId ?? "ok";

  if (command === "crash") {
    // Die WITHOUT replying — models the worker's own OOM mid-scan.
    process.exit(7);
  }
  if (command === "error") {
    await sendMessage({ id, error: "worker boom" });
    continue;
  }
  if (command === "slow") {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  // Echo enough to assert behaviour: which process answered (reuse/isolation/disposal) and which
  // request this reply belongs to (round-trip / serialization correctness).
  await sendMessage({
    id,
    result: { tool: "sonarjs", findings: [], skipped: false, workerPid: process.pid, echoedFiles: ctx?.files ?? [] },
  });
}
