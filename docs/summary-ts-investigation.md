# Investigation: `tend run src/output/summary.ts` — fixed and remaining issues

`src/output/summary.ts` is the pathological stress case: ~20 in-scope findings on one file, many
of them `jscpd` `duplicate-code`. It exposed several distinct bugs. This doc records what was
found, what is fixed (with proof), and what remains — so the work can be finished without
re-deriving it.

All findings below come from instrumented runs of `tend run src/output/summary.ts` (temporary
`TEND_DEBUG` tracing, since removed) plus deterministic git-level / unit tests.

---

## Fixed (shipped on branch `fix/sandbox-advancing-base`, PR #19)

### C — Sandbox forked from a frozen base → patch conflicts → non-convergence  ✅
- **Cause:** the worker-sandbox pool was created with one base commit (`snapshotSha`) captured at
  run start and never advanced. Every sandbox `git reset --hard`s to it (`worker-sandbox.ts`), so
  a file's 2nd+ fix forked from the *original* state, produced a diff-from-original, and 3-way
  merged against a main that already had the earlier fixes → `Applied patch to '<file>' with
  conflicts` → reverted → retried → never converged.
- **Evidence:** a frozen-base run reported loop 1 = 3 fixed, **6 reverted (5 patch-conflict)**, 55
  remaining; `staleFiles` climbed 0→1→2 against the frozen base.
- **Fix:** after each accepted patch, commit main's tree (pinned by `refs/tend/sandbox-base`) and
  advance the pool's base; each sandbox records the base it reset to and diffs against *that*.
  Sequential same-file fixes now merge trivially; concurrent different-file work is unaffected.
- **Proof:** regression test (two overlapping sequential fixes) fails without the fix with the
  exact `Applied patch ... with conflicts` message, passes with it. A full run converged
  **20 → 5 → 3 → 0 in-scope, fixed=21, 0 patch conflicts.**

### A — Session timeout not enforced under load (orphaned `claude` processes)  ✅
- **Cause:** `claude -p` ignores `SIGTERM`. On the session-timeout abort, execa fell back to its
  `forceKillAfterDelay` (~5s) `SIGKILL` escalation — a JS timer. Un-killed sessions accumulated,
  saturated CPU (load avg 15), and starved the event loop, so **every** timer (including the
  10-min session cap) fired minutes late. Sessions ran 30+ min against a 10-min cap
  (`timer-fired durS` up to **2029s** for a 180s cap); orphaned `claude` processes lingered (one
  at 29% CPU). This is what made a converging run take **192 minutes**.
- **Fix:** `killSignal: "SIGKILL"` on the spawn (`bin.ts`). A timed-out session dies on the first
  (still-accurate) timeout with no second timer, so orphans never accumulate and the cap holds.
  `CLAUDE_TIMEOUT_MS` is also overridable via `TEND_SESSION_TIMEOUT_MS`.
- **Proof:** isolated test — a `SIGTERM`-ignoring child dies in **1ms** with `SIGKILL` vs lingering
  past the 5s escalation (far longer under load) by default. In a real run the cap then fired
  cleanly (`reverted — AI session timed out after 5m (5:01)`), load stayed ~4, sessions ~3 (no
  pile-up).

### B — never-batch `duplicate-code` (tried, then REVERTED)  ⛔
- **Idea:** give each `duplicate-code` finding its own session instead of batching them, to avoid a
  doomed multi-dup batch that burns the whole cap before splitting.
- **Why reverted:** with each dup as a single-finding unit, a dup that times out has nothing to
  split (`shouldSplitAfterFailure` only fires on multi-finding units) and is marked **terminally
  unfixable** (`orchestrator.ts:173`). Run evidence: with this change + an enforced cap, 4
  `duplicate-code` findings timed out terminally and the file did not converge. Plain batching at
  least splits-and-retries a timed-out batch. Net value unproven / likely negative, so it's out.
  The real fix for the underlying problem is Issue 1 below (retry timed-out findings later).

Status: `tsc` clean, **452 tests pass**, build clean. (Shipping: Fix C + Fix A only.)

---

## Remaining issues (NOT fixed)

### 1 — Timed-out findings are marked terminally unfixable, never retried  ⛔ (highest priority)
This is why `summary.ts` still does not reach a clean **exit 0**.

- **Code:** `orchestrator.ts:173` classifies `tool-timeout` as a terminal "no-burn" failure;
  `:209-211` sets `finding.status = "unfixable"` immediately (no attempt burned, **no re-queue**).
  `shouldSplitAfterFailure` (`:241`) only splits multi-finding units, so a single `duplicate-code`
  unit that times out has no retry path at all.
- **Consequence:** in a bounded-cap run, hard `duplicate-code` findings time out **once** and are
  permanently unfixable. Observed: a 5-min-cap run reached 5 fixed, **4 timed-out → unfixable**,
  and therefore could not converge to 0.
- **Why it's now wrong:** the terminal policy predates Fix C. With the advancing base, a finding
  that times out *early* (full duplication, hard) would likely **fit the cap and succeed when
  retried later**, once earlier fixes have thinned the duplication. This is exactly how the
  192-min run converged — its dups happened to run late, from a cleaned base, finishing in
  15–87s.
- **Proposed fix:** stop marking `tool-timeout` as terminal. Allow a **bounded** number of retries
  in *later* loops (e.g. 1–2), so a timed-out finding gets another attempt against the advanced
  (cleaner) base. Keep the bound so a genuinely-too-big finding can't loop on timeouts forever.

### 2 — `finalIntegration` is inconsistent with finding routing → false `exit 1`  ⚠️
- **Code:** `bin.ts` `finalIntegration()` calls raw `scanFindings(acceptedFiles, acceptedTools)`
  and fails if **any** finding remains. It does **not** apply the `route()`/`track` filtering
  (`findings/router.ts`) or the in-scope/report-only routing the orchestrator uses.
- **Consequence:** it counts findings tend *intentionally never fixes* — report-only test
  duplicates ("test setup is meant to repeat"), sub-`MIN_DUPLICATE_LINES` clones, out-of-scope
  findings. The 192-min run converged (orchestrator: 0 in-scope) yet ended
  `final-integration status=failed ... found 2 findings` → **exit 1**.
- **Open:** the exact 2 findings were not captured per-item (the detail is only a count). Confirm
  they are report-only/out-of-scope (most likely), vs genuinely new regressions.
- **Proposed fix:** final integration should only fail on findings that are actually
  fixable/in-scope — reuse the same routing + scope filter the orchestrator applies, excluding
  report-only and out-of-scope. If they turn out to be *new* regressions, that's a different
  (real) bug to chase.

### 3 — Dense files are inherently slow (design limitation, not a bug)  ℹ️
- A single file's findings must be fixed **sequentially** (the no-two-sessions-touch-one-file
  invariant is what prevents the Fix-C patch conflicts), and each `duplicate-code` finding is a
  1–5 min AI refactor. So a 20-finding file ≈ tens of minutes regardless.
- Already optimized: cheap findings batch 5-per-session; prompt caching on; different files run
  in parallel.
- Levers all have real downside: a single atomic "dedup whole file" session is **likely worse**
  (bigger task → more timeout, per the batching evidence); report-only dups drop the dedup;
  lower thinking budget trades quality. No clean large speedup is available.
- `summary.ts` is the worst case (that's why it was the repro). Typical files (1–3 findings)
  finish in a minute or two.

---

## Recommended next steps (in order)

1. **Fix issue 1** (bounded retry of timed-out findings) — this is what lets dense dup files
   actually converge, and it's the natural completion of Fix C. Then re-run `summary.ts` to a
   real terminal state.
2. **Fix issue 2** (make `finalIntegration` consistent with routing) — needed for a clean
   `exit 0`. First capture the 2 findings to confirm they're report-only/out-of-scope.
3. **Issue 3** is a product decision, not a quick fix; revisit only if dense-file latency is a
   real requirement.

## How to reproduce / measure
```
pnpm build
PATH="$PWD/node_modules/.bin:$PATH" TEND_SESSION_TIMEOUT_MS=300000 node dist/bin.js run src/output/summary.ts --plain
```
Watch: `✔ fixed` / `↩ reverted — AI session timed out` counts, the per-loop `in-scope findings`
count (should fall to 0), `final-integration status`, and the process load / `claude` session
count (should stay low — no orphan pile-up). Restore with `git checkout -- src/output/summary.ts
src/output/summary.test.ts` and prune `tend-worker-*` worktrees afterward.
