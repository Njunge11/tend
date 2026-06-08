# Fix 1 — Per-finding thinking budget

**Status:** proven (biggest measured win) · **Read first:** [`_testing-philosophy.md`](./_testing-philosophy.md)

## Problem (measured)
Every AI fix runs Sonnet with extended thinking uncapped, burning ~7000 reasoning tokens per finding regardless of difficulty. Measured on tend's own repo: one 2-finding file = 2m41s; with thinking off the ~7000 tokens vanish (8101 → 893 output tokens). Through the full gated flow, reasoning-heavy fixes dropped 238s→81s and 162s→95s with **no correctness loss** (gate green, all findings fixed). Today the budget is unbounded for every finding.

## Behavior
The thinking budget is derived from the finding and applied to the model session:
- mechanical findings (dead-code / autofixable) → thinking off / 0
- reasoning findings (e.g. cognitive-complexity) → bounded positive budget (≤ cap)
- user config can override the budget.

## Boundary (what tests may assert)
- the **return value** of a pure policy function, e.g. `thinkingBudgetFor(finding, config)` — this is the primary contract.
- one integration smoke: the chosen budget reached the session boundary (assert the *decision*, not env-vs-flag delivery).

## Test cases
- [ ] mechanical category → budget = `off`/0
- [ ] reasoning category (cognitive-complexity) → bounded positive (≤ cap)
- [ ] unknown/other category → documented safe default
- [ ] config override set → returned budget == configured value (override wins)
- [ ] config override = 0 → `off` respected
- [ ] mixed-category unit (many findings, one file) → most-conservative budget (documented rule)
- [ ] integration smoke: a mechanical-finding fix runs its session with thinking disabled (decision arrived; do not assert how)

## Likely touch points
`src/fixing/repair-strategy.ts` (category→strategy), `src/bin.ts` (session spawn), `src/config/config.ts` (override). Add a pure `thinkingBudgetFor` as the tested unit.
