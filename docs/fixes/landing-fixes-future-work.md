# Making AI fixes actually LAND (future work)

Two failures where findings end up unfixed. Both are about the fix *succeeding*, not
about safety. The safety net (revert-to-known-good on final-integration failure) already
shipped in commit `f0b834d`; the items below are about raising the success rate instead.

## Issue 1 — combined break (the "email" case): make parallel fixes land

**Symptom:** 15 fixes each pass per-unit typecheck but break the COMBINED tree
(e.g. TS2769 / TS2367), so final-integration reverts them and the findings stay unfixed.

**Root cause:** each fix is gated in an isolated git worktree (base + only its own fix).
Concurrent sessions can't see each other's edits, so two individually-valid fixes can
interact (e.g. two type-narrowings make a third file's `a === b` have no overlap). The
per-unit gate structurally cannot catch this; it's only caught once at the end.

**Fix:** apply the "Not Rocket Science Rule" — verify against the *integrated* tree, not
the isolated change. After an accepted fix is written to the real tree, re-run the gate
against the real combined tree (base + all already-accepted fixes this run). On a new
error, route it into the existing repair loop and let the model fix the integration in
place so ALL fixes stay landed. Drop a fix only if repair genuinely can't.

Source pointers:
- `src/bin.ts:345` `makeGateDeps(sandbox)` — gate; `runTsc` cwd is inside the worktree (isolated check)
- `src/bin.ts:516` `applyPatchToMain` — accepted fix written to real tree, NO integrated re-check after
- `src/fixing/worker-sandbox.ts:421` `applyPatchToMain` internals; `advanceBase()`
- `src/fixing/fix-unit.ts:488` `runRegressionRepair` — EXISTING error-fed repair loop (cap 2); reuse it
- `src/bin.ts:828` `finalIntegration()` — too-late end-of-run check + rollback (keep as final safety net)

Precedent (serious-engineering, not a hobby tool): the Not Rocket Science Rule
(Graydon Hoare / Rust `bors`), Jane Street "never break the build", Google TAP, OpenStack
Zuul speculative gating — all gate on the *integrated* state. Meta SapFix validates a patch
("does the fix introduce new crashes?") before it's accepted.

## Issue 2 — single fix can't clear the finding (the "members" case): escalate to Opus

**Symptom:** one fix adds a new `duplicate-code`; another breaks typecheck (TS2367) — the
default model can't clear the finding without breaking something, so it's reverted and the
finding is left. This is a genuine model-capability limit, not a tend bug — tend already
feeds the exact error back (`runRegressionRepair`), retries (cap 2), then safely reverts.

**Fix:** escalate-on-failure. When a finding exhausts the default model's (Sonnet) repair +
retries, re-attempt with **Opus** before reverting, instead of giving up. tend already
escalates certain units to the capable/Opus tier via `modelForUnit`
(`src/fixing/model-selection.ts`), so this is "on failure, bump the tier," not new
machinery. Fires only on findings that actually fail → cost stays bounded. Won't clear
everything (some findings are genuinely hard or are false positives), but raises success on
exactly the cases reverted today.

**The load-bearing detail — Opus needs the right context.** Opus only helps if it sees *why*
the default model failed, so it doesn't repeat the same dead ends. The escalated session
must receive the full failure package:

```
                    FINDING (e.g. TS2367)
                          │
                          ▼
                ┌───────────────────────┐
                │  Sonnet fix in sandbox │
                └───────────┬───────────┘
                            ▼
                      ┌───────────┐   pass
                      │   GATE    │────────────▶ LAND (fixed)
                      │ tsc/tests │
                      └─────┬─────┘
                            │ fail (new error)
                            ▼
                ┌───────────────────────────┐
                │ Sonnet regression-repair   │  ◀── error fed back
                │ (cap 2 retries)            │
                └───────────┬───────────────┘
                            │ still failing
                            ▼
       ╔════════════════════════════════════════════════╗
       ║   ESCALATE → OPUS                               ║
       ╚════════════════════════════════════════════════╝
                            │
          hand Opus the FULL context package:
          ┌───────────────────────────────────────────┐
          │ • the finding (file, rule, message, range) │
          │ • current file contents                    │
          │ • EVERY prior failed attempt (the diffs)   │
          │ • the EXACT gate error each attempt threw  │
          │   (tsc TS2367 text, new findings, tests)   │
          │ • forbidden shortcuts (no @ts-ignore/any)  │
          │ • success condition (finding gone + green) │
          └───────────────────────────────────────────┘
                            ▼
                      ┌───────────┐   pass
                      │   GATE    │────────────▶ LAND (fixed by Opus)
                      └─────┬─────┘
                            │ fail
                            ▼
                    REVERT → couldn't-fix
```

tend already assembles most of this in `renderRegressionRepairPrompt` (rejected diff + exact
errors + forbidden shortcuts). The escalation should reuse that prompt with `model = Opus`
and additionally **accumulate ALL prior attempts** (not just the last snapshot), so Opus gets
the full failure history.

**Caveat (measure first):** repair-loop research shows stronger-model gains are real but
sometimes modest once priced in — measure Sonnet-vs-Opus repair success on a few real cases
before locking the default.
