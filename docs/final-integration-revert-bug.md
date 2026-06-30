# Final-integration reverts clean fixes over scanner findings

## Issue

After a run, the final-integration gate reverts **every** accepted fix when its scanner
rescan reports new findings — even when the code compiles and tests pass. New scanner
findings are treated like a broken build.

Real run (`apps/dashboard/lib`, `/Users/njungenjenga/Personal/ajiri-monorepo/.tend/report.json`): `typecheckFailures: 0`,
`testFailures: 0`, `finalIntegrationFailures: 61`, `finalIntegration.detail:
"final integration scanner rescan found 5 findings"`. **61 working fixes wiped because the
scanners reported 5 new findings; nothing was broken.** ~$10.40, ~70 min, 0 fixes kept.

Code path:
- `runFinalIntegration` (`/Users/njungenjenga/Personal/tend/src/bin.ts:463`): after typecheck + tests pass, runs the scanner
  rescan and returns `{ ok: false }` on any unrepaired finding (`/Users/njungenjenga/Personal/tend/src/bin.ts:482-484`) — a
  scanner finding is treated identically to a compile error.
- `rollbackFailedIntegration` (`/Users/njungenjenga/Personal/tend/src/bin.ts:959`): on `ok: false` calls
  `sandboxPool.rollbackMainChanges()` with **no file list** (`/Users/njungenjenga/Personal/tend/src/bin.ts:966`).
- `rollbackMainChanges()` (`/Users/njungenjenga/Personal/tend/src/fixing/worker-sandbox.ts:537`): with no arg, overwrites
  every file in `pristineMain` with its pre-run bytes (deletes files the run created). It is
  all-or-nothing and never maps findings to the fixes that caused them.

## Why it's an issue

- Each reverted fix already passed its own per-unit gate (typecheck + tests + rescan) before
  being applied — the rollback destroys individually-verified work.
- A new scanner finding (`unused-export`, `duplicate-code`, …) is information, not a broken
  build; treating it as grounds to wipe the run is the wrong severity.
- The new findings are unrelated to the fixes being reverted; the rollback reverts everything
  any fix touched.
- The fixes are overwritten on disk (not a git commit) and the AI spend is gone.

## Solution

**A fix that has not broken anything is never auto-reverted. Only `tend undo` removes a kept
fix.**

1. In `runFinalIntegration` (`/Users/njungenjenga/Personal/tend/src/bin.ts:482-484`): once typecheck and tests pass, scanner
   rescan findings are **reported, not reverted** — return `ok: true` and carry the findings.
   `ok: false` only when `typecheckFailure` or `testFailure` is set.
2. Remove the scanner-finding path into `rollbackFailedIntegration` → `rollbackMainChanges()`
   (`/Users/njungenjenga/Personal/tend/src/bin.ts:966`) so it never fires on findings.
3. Record the rescan findings by identity (tool / rule / file / line) in the `finalIntegration`
   report object instead of just a count.

## How to test

1. **Reproduce signature** — `/Users/njungenjenga/Personal/ajiri-monorepo/.tend/report.json`:
   confirm `typecheckFailures == 0`, `testFailures == 0`, `finalIntegrationFailures == 61`.
2. **Automated** — `runFinalIntegration` returns `ok: true` when typecheck/tests pass and the
   rescan returns findings; `rollbackMainChanges()` is not called for a findings-only result;
   the report carries the findings' identities.
3. **Targeted live run** (real binary, real AI/scanners/gate, ~cents): run `tend` on
   `apps/dashboard/lib/email/templates/` — its 4 `jscpd/duplicate-code` findings create
   `email/templates/_shared.tsx` (one of `finalIntegration.files`), reproducing the exact
   cascade that wiped the run. Expected: deduped fixes stay on disk, the new finding is
   reported, only `tend undo` restores the pre-run state. (AI is non-deterministic — widen by
   a file or two if the gate doesn't fire.)

## Resolution

Fixed in `src/bin.ts`, `src/report/schema.ts`, `src/output/summary.ts`:

1. `runFinalIntegration` now returns `ok: true` once typecheck and tests pass — a scanner rescan
   finding that the (still-attempted) in-place repair couldn't clear is **carried on the result
   and reported**, never `ok: false`. `ok: false` is now reachable only via `typecheckFailure`
   or `testFailure`. The repair budget is preserved so a trivially-fixable surfaced finding is
   still auto-cleaned; whatever survives it is reported, not reverted.
2. Because findings yield `ok: true`, they never reach `rollbackFailedIntegration` →
   `rollbackMainChanges()`. The rollback path now fires only for a genuine compile/test break.
3. `FinalIntegrationSchema` gained a `findings` array recording each surfaced finding by identity
   (`tool` / `rule` / `file` / `line`); `toReportFinalIntegration` maps the gate result into it.
   The summary shows `N new findings reported · fixes kept` instead of a "reverted" line.

Covered by `runFinalIntegration` and `toReportFinalIntegration` unit tests in `src/bin.test.ts`.
