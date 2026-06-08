# tend fixes — index

Each fix is a self-contained file. Implement with TDD (red → green → refactor),
**one fix per session, sequentially — do not jump ahead.** Read
[`_testing-philosophy.md`](./_testing-philosophy.md) at the start of every session.

## Sequence

| # | Fix | Status | Why this order |
|---|-----|--------|----------------|
| 1 | [Per-finding thinking budget](./01-thinking-budget.md) | proven | biggest measured win; independent |
| 2 | [Clean teardown](./03-clean-teardown.md) | clear | correctness; stops repo junk; independent |
| 3 | [Live progress](./02-live-progress.md) | clear | visibility; independent |
| 4 | [Worktree deps reuse](./04-worktree-deps-reuse.md) | de-risk first | cuts ~30s floor; spike before TDD |
| 5 | [Incremental typecheck](./05-incremental-typecheck.md) | de-risk first | cuts ~30s floor; spike before TDD |
| 6 | [Supply file content](./06-supply-file-content.md) | optional | minor efficiency |

Recommended order is by table row (1 → 3 → 2 → 4 → 5 → 6 by filename). Fixes 4 and
5 each require a **de-risk spike** (described in their files) before writing tests —
if the spike fails, skip the fix.

## The two issues these fix
1. **Too slow** — mainly unbounded model "thinking" per fix (Fix 1), on top of a
   fixed per-run install + typecheck floor (Fixes 4, 5).
2. **Can't tell what's happening** — silent during the AI edit (Fix 2).

Plus correctness/hygiene: the repo must end exactly as it started (Fix 3).
