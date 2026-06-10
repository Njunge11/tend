/**
 * Fail-fast validation that every model a run can route to actually exists and is
 * accessible, before any scanning or fixing starts.
 *
 * `claude -p` exits 0 even when the model doesn't exist — the failure is only
 * visible in its JSON result payload (`is_error: true`, `api_error_status: 404`,
 * "There's an issue with the selected model (…)"). Without this check a typo'd
 * model (e.g. `claude-opus-4.6` instead of `claude-opus-4-6`) burns entire fix
 * passes: every session "succeeds" without editing anything and every unit fails
 * as a no-op session error.
 *
 * Detection fails closed only on explicit signals — `is_error` in the parsed
 * result payload, a nonzero exit with no payload, or a spawn failure. If the
 * CLI's output format drifts and the payload no longer parses, the preflight
 * passes rather than bricking every run; the per-unit gate still catches a
 * genuinely broken model, just later.
 */

/** Runs one `claude -p` ping against `model` and returns its stdout + exit code. */
export type ModelPing = (model: string) => Promise<{ stdout: string; exitCode: number }>;

export type ModelPreflightFailure = { model: string; detail: string };

export type ModelPreflightResult = { ok: true } | { ok: false; failures: ModelPreflightFailure[] };

type ResultPayload = { type?: string; is_error?: boolean; result?: string };

/**
 * Find the `--output-format json` result object in a ping's stdout. Scans lines
 * from the end so anything the CLI prints around the payload is ignored.
 */
function parseResultPayload(stdout: string): ResultPayload | undefined {
  for (const line of stdout.trim().split("\n").reverse()) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && (parsed as ResultPayload).type === "result") {
        return parsed as ResultPayload;
      }
    } catch {
      // Not JSON — keep scanning.
    }
  }
  return undefined;
}

/** Ping every distinct model concurrently; report all failures, not just the first. */
export async function preflightModels(models: string[], ping: ModelPing): Promise<ModelPreflightResult> {
  const distinct = [...new Set(models)];
  const failures = (
    await Promise.all(
      distinct.map(async (model): Promise<ModelPreflightFailure | undefined> => {
        let stdout: string;
        let exitCode: number;
        try {
          ({ stdout, exitCode } = await ping(model));
        } catch (error) {
          return { model, detail: error instanceof Error ? error.message : String(error) };
        }
        const result = parseResultPayload(stdout);
        if (result?.is_error) return { model, detail: result.result ?? "model rejected by claude -p" };
        if (!result && exitCode !== 0) return { model, detail: `claude -p exited ${exitCode}` };
        return undefined;
      }),
    )
  ).filter((failure): failure is ModelPreflightFailure => failure !== undefined);
  return failures.length === 0 ? { ok: true } : { ok: false, failures };
}
