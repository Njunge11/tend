# Deprecated fallback fix task

Strategy: `{{strategyName}}`

This template is deprecated. It exists only as a fallback for an unknown repair
strategy. Prefer one of the strategy-specific templates in this directory.

## Findings JSON

{{findings}}

## Editable files

Only edit these repo-relative files:

{{editableFiles}}

Do not edit any other file.

## Verification targets

The gate will verify these repo-relative files:

{{verificationTargets}}

## Forbidden shortcuts

- Do not add `eslint-disable`, `@ts-ignore`, `@ts-nocheck`, casts to `any`, or
  `any` type annotations.
- Do not weaken tests, remove assertions, or delete behavior merely to hide a finding.
- Do not edit outside the listed editable files.

## Exact success condition

The listed findings no longer appear on the verification targets, behavior is
preserved, and the gate passes without new findings or suppressions.

## Output

Use `Write` or `Edit` to update the editable file contents on disk.
