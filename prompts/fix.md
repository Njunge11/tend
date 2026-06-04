# Fix task

You are fixing static-analysis findings that have already been located. You do **not**
need to search broadly for unrelated problems.

## The findings

{{findings}}

## Editable files

Only edit these repo-relative files:

{{editableFiles}}

Do not edit any other file. If the correct fix requires another file, leave the files
unchanged.

## Rules

1. **Fix the underlying issue**, not the symptom. Never silence a finding by adding
   `eslint-disable`, `@ts-ignore`, `@ts-nocheck`, casting to `any`, or adding `any`
   type annotations. Such edits are rejected automatically.
2. **Preserve behavior.** The tests are the behavior oracle. If a fix legitimately
   requires a test change (e.g. an import moved during a refactor), make it — but never
   weaken an assertion to make a failing test pass. A test you edit must still fail
   against the old code.
3. **Do not delete code merely to hide a finding.** For dead-code findings, deletion is
   allowed only when it is the minimal behavior-preserving fix.
4. **Stay in scope.** Edit only the listed editable files. Do not touch other files.
5. **Type-correct.** The result must pass `tsc --noEmit` (when the project uses TypeScript).
6. **Don't introduce new findings.** A fix that trades one issue for another is rejected.

## Output

Use `Write` or `Edit` to update the editable file contents on disk.
