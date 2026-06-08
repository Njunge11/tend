# Fix 5 — Incremental typecheck cache (cut tsc floor)

**Status:** NOT yet de-risked — spike before TDD · **Read first:** [`_testing-philosophy.md`](./_testing-philosophy.md)

## Problem (measured)
The gate runs `npx tsc --noEmit` over the whole owning package, with no incremental cache, after the initial edit + every repair + final integration (`src/bin.ts` `runTsc`). Each run is a cold full-package typecheck. It contributes to the ~30s floor that thinking budget cannot touch.

## De-risk spike (do this FIRST)
Confirm `tsc --incremental --tsBuildInfoFile <tend-cache>` works with `--noEmit` and that the cache, stored OUTSIDE the worktree, survives `reset()`/`git clean` between iterations and is actually reused. If the cache can't survive the worktree lifecycle, rethink before writing tests.

## Behavior
The typecheck gate uses an incremental build cache in a **tend-owned** location (e.g. under `.tend/cache/`); consumer `tsconfig` semantics are unchanged. Only caching/speed flags are added — never correctness flags.

## Boundary (speed-only — test the contract, not delivery)
The tsc exec command-runner boundary · filesystem (cache file presence). Do **not** assert timing.

## Test cases
- [ ] typecheck invoked with an incremental cache file under tend's cache dir (not the consumer tree)
- [ ] cache path lies outside the worktree (survives worktree reset/clean)
- [ ] only caching flags passed — no `skipLibCheck` or tsconfig-semantic flags injected (correctness guard)
- [ ] second gate run reuses the existing cache file (assert file written + reused, NOT timing)
- [ ] cache file absent/corrupt → typecheck still runs and reports correct pass/fail

## Likely touch points
`src/bin.ts` (`runTsc`), cache dir under `.tend/`.
