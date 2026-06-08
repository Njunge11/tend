# Fix 5 — Incremental typecheck cache (cut tsc floor)

**Status:** implemented · **Read first:** [`_testing-philosophy.md`](./_testing-philosophy.md)

> **Spike result (de-risked):** On TS 5.9, `tsc --noEmit --incremental --tsBuildInfoFile <path outside the worktree>` works: cold run ~1.8s writes the build-info; warm run ~1.0s reuses it (exit 0); a **corrupt** build-info file → tsc rebuilds and still exits 0 (correct pass). The cache lives under the main repo's `.tend/cache/`, so it is never inside a sandbox worktree and survives `reset()`/`git clean`.

## Problem (measured)
The gate runs `npx tsc --noEmit` over the whole owning package, with no incremental cache, after the initial edit + every repair + final integration (`src/bin.ts` `runTsc`). Each run is a cold full-package typecheck. It contributes to the ~30s floor that thinking budget cannot touch.

## De-risk spike (do this FIRST)
Confirm `tsc --incremental --tsBuildInfoFile <tend-cache>` works with `--noEmit` and that the cache, stored OUTSIDE the worktree, survives `reset()`/`git clean` between iterations and is actually reused. If the cache can't survive the worktree lifecycle, rethink before writing tests.

## Behavior
The typecheck gate uses an incremental build cache in a **tend-owned** location (e.g. under `.tend/cache/`); consumer `tsconfig` semantics are unchanged. Only caching/speed flags are added — never correctness flags.

## Boundary (speed-only — test the contract, not delivery)
The tsc exec command-runner boundary · filesystem (cache file presence). Do **not** assert timing.

## Test cases
- [x] typecheck invoked with an incremental cache file under tend's cache dir (not the consumer tree)
- [x] cache path lies outside the worktree (survives worktree reset/clean)
- [x] only caching flags passed — no `skipLibCheck` or tsconfig-semantic flags injected (correctness guard)
- [x] second gate run reuses the existing cache file (assert file written + reused, NOT timing)
- [x] cache file absent/corrupt → typecheck still runs and reports correct pass/fail — corrupt-cache resilience proven by the spike; the test asserts the run still happens and reports tsc's exit code

## Likely touch points
`src/bin.ts` (`runTsc`), cache dir under `.tend/`.
