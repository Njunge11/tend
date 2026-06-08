# Fix 4 — Reuse node_modules in worktrees (cut install floor)

**Status:** NOT yet de-risked — spike before TDD · **Read first:** [`_testing-philosophy.md`](./_testing-philosophy.md)

## Problem (measured)
Even with thinking off, cheap fixes floor at ~30s. Part of that floor: each fix unit runs in a fresh `git worktree` with no `node_modules`, so `prepare()` runs a full `install` per worktree (`src/fixing/worker-sandbox.ts`). tend only edits source and rejects unowned patches, so the main checkout's `node_modules` is already valid for the sandbox.

## De-risk spike (do this FIRST, before writing tests)
Prove that symlinking (or reflink/copy) the main repo's `node_modules` into a worktree lets a real fix's gate (`tsc` + tests) resolve correctly — **on a pnpm repo specifically**, since pnpm's symlink-farm/global-store layout is the most likely to break. If it doesn't resolve, this fix is dead; stop here.

## Behavior
A sandbox worktree reuses the main repo's installed deps instead of reinstalling; it reinstalls only when the unit changes dependency manifests (package.json / lockfile). Package-manager-agnostic; requires no consumer config.

## Boundary (speed-only — test the DECISION, not delivery)
Pure decision function, e.g. `shouldReinstall(unit) → bool`, plus the install/exec command-runner boundary.

## Test cases
- [ ] unit does NOT touch package.json/lockfile → decision = reuse (no install command executed)
- [ ] unit DOES include package.json/lockfile → decision = reinstall (install command executed)
- [ ] reused-deps worktree → a normal fix still passes its gate (typecheck/tests resolve)
- [ ] each supported package manager (npm/pnpm/yarn/bun) → same reuse decision (documented matrix)
- [ ] main repo has no node_modules → falls back to install, no crash

## Likely touch points
`src/fixing/worker-sandbox.ts` (`prepare`/`acquire` — reuse vs `installArgs`).
