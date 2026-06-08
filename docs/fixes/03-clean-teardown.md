# Fix 3 — Clean teardown (repo stays exactly as before)

**Status:** clear (correctness) · **Read first:** [`_testing-philosophy.md`](./_testing-philosophy.md)

## Problem (observed)
Cancelling a run (Ctrl-C) left two registered `tend-worker-*` git worktrees, because `WorkerSandboxPool.dispose()` only runs on the normal `finally` path (`src/bin.ts`), not on SIGINT/crash. And `tend undo` restored the working tree but **not the index**, so pre-existing staged changes split into a confusing staged/unstaged mirror state.

## Behavior
After success, cancel, or crash: no leftover worktrees/temp dirs. `tend undo` restores the exact pre-run git state — working tree **and** index. A crashed prior run is self-healed on next startup.

## Boundary (what tests may assert)
git state · filesystem · CLI output · exit code.

## Test cases
- [ ] normal completion → zero `tend-worker` worktrees registered; temp dirs gone
- [ ] SIGINT mid-run → zero `tend-worker` worktrees registered; temp dirs gone
- [ ] startup with a stale `tend-worker` worktree present → pruned at/before run start
- [ ] `undo` with pre-existing **staged** changes → staged set identical to pre-run
- [ ] `undo` with pre-existing **unstaged** changes → working tree identical to pre-run
- [ ] `undo` on a clean repo → repo clean afterward (no staged/unstaged split)
- [ ] `.tend/` artifacts → not reported as untracked by `git status`

## Likely touch points
`src/fixing/worker-sandbox.ts` (`dispose`, idempotent; startup `git worktree prune`), `src/bin.ts` (SIGINT/SIGTERM handlers), `src/git/snapshot.ts` (capture + restore index), `.gitignore` policy for `.tend/`.
