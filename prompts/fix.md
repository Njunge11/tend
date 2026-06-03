# Fix task

You are fixing a single file in a codebase. A set of static-analysis findings has been
located for you precisely — you do **not** need to search for what's wrong.

## The findings

{{findings}}

## File

`{{file}}` (and its sibling test, if one exists).

## Rules

1. **Fix the underlying issue**, not the symptom. Never silence a finding by adding
   `eslint-disable`, `@ts-ignore`, `@ts-nocheck`, casting to `any`, or deleting the
   offending code. Such edits are rejected automatically.
2. **Preserve behavior.** The tests are the behavior oracle. If a fix legitimately
   requires a test change (e.g. an import moved during a refactor), make it — but never
   weaken an assertion to make a failing test pass. A test you edit must still fail
   against the old code.
3. **Stay in scope.** Edit only `{{file}}` and its sibling test. Do not touch other files.
4. **Type-correct.** The result must pass `tsc --noEmit` (when the project uses TypeScript).
5. **Don't introduce new findings.** A fix that trades one issue for another is rejected.

## Output

Use the `Write` tool to emit the full, corrected contents of each file you change.
