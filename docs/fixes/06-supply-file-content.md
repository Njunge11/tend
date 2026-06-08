# Fix 6 — Supply file content to the apply step (remove a Read turn)

**Status:** implemented · **Read first:** [`_testing-philosophy.md`](./_testing-philosophy.md)

## Problem (observed)
The single-file fix prompt (`prompts/single-file-ai-edit.md`) gives the model the findings JSON (with exact line ranges) and the editable file paths, but **not the file contents** — so the model must `Read` the file itself before editing, adding a tool round-trip per fix. The prompt already scopes the model correctly; this is an efficiency gap, not a correctness one.

## Behavior
For single-file fixes, the model receives the target file's current content as session input, so it need not Read it first.

## Boundary (what tests may assert)
The session `spawn` **input** includes the file's source (content present) — NOT the surrounding template wording.

## Test cases
- [x] single-file fix → session input contains the target file's current source
- [x] file missing/unreadable → clean failure outcome, no crash

## Likely touch points
`src/fixing/fix-unit.ts` (`renderPrompt`), `prompts/single-file-ai-edit.md`. Note: do not assert exact prompt wording — only that content is supplied.
