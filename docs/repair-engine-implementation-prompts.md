# Tend Repair Engine Implementation Prompts

Use these prompts in order, one per fresh session. Each prompt is scoped so the agent can implement, test, and stop without renegotiating product direction.

Common instruction for every session:

```text
You are working in /Users/njungenjenga/Personal/tend.

Do not ask clarifying questions. Make conservative product decisions that preserve Tend's core promise: scan issues, fix them, verify them, and report truthfully.

Do not hide fixable issues by moving them to report-only. If something cannot be fixed by the current strategy, implement the correct strategy or return an explicit machine-readable reason that a later strategy can handle.

Do not revert unrelated local changes. Read the current code before editing. Use existing project style. Add focused tests for every behavior change. Verify with the narrow tests you changed plus `pnpm run typecheck`.
```

## Session 1: Repair Scope And Ignore Policy

```text
Task: Implement separate report scope and fix scope so Tend stops spending AI sessions on generated/cache/tooling artifacts while still reporting them clearly.

Context:
- Tend is a general tool for other developers' repositories.
- The fix is not to hardcode this repo's preferences.
- The fix is to define a default, overridable policy:
  - reportScope: findings Tend can show in the report
  - fixScope: findings Tend is allowed to spend fix attempts on
- Project config and scanner-native behavior should be respected first.

Files to inspect:
- src/scanners/all.ts
- src/scanners/eslint-sonarjs.ts
- src/scanners/jscpd.ts
- src/scanners/knip.ts
- src/config/config.ts
- src/orchestrator.ts
- src/report/schema.ts
- src/output/summary.ts
- src/scanners/*.test.ts
- src/output/summary.test.ts
- src/orchestrator.test.ts

Implement:
1. Add a shared scope policy module, for example `src/scanners/scope-policy.ts`.
2. Model default excluded-from-fix classes:
   - dependency/vendor dirs: node_modules, .git
   - Tend/tool/cache dirs: .tend, .turbo, .next, .vercel, coverage
   - common generated outputs: dist, build, out
   - generated declaration artifacts: emitted .d.ts/.d.ts.map under generated/build output
   - fixtures: test/fixtures, tests/fixtures, __fixtures__
3. Do not remove these findings from reportScope unless a scanner itself ignores them.
4. Mark findings with scope metadata:
   - inReportScope
   - inFixScope
   - scopeExclusionReason when not fixable by default
5. Add config support for override:
   - `fix.include`
   - `fix.exclude`
   - `fix.includeGenerated`
   - `fix.includeFixtures`
   Keep defaults backward compatible.
6. Summary must show excluded-from-fix counts separately:
   - generated
   - fixtures
   - tests
   - out of scope

Acceptance criteria:
- `--all` can report generated/fixture findings but does not dispatch them to AI by default.
- A finding in `dist/index.d.ts` is visible in the report but not included in fix units unless explicitly included.
- A finding in `src/a.ts` remains eligible.
- Existing changed-file/path-scoped behavior still works.

Tests:
- Add unit tests for the scope policy.
- Add orchestrator tests proving non-fix-scope findings are not dispatched but remain in the report.
- Add summary tests proving generated/fixture/test counts render separately.
- Run:
  - pnpm exec vitest run src/scanners/scope-policy.test.ts src/orchestrator.test.ts src/output/summary.test.ts --reporter=dot
  - pnpm run typecheck
```

## Session 2: Truthful Report Semantics And Exit Status

```text
Task: Fix report semantics so the rendered summary tells the truth about why a run failed.

Problem:
- Current summary collapses unfixable findings into "exhausted retries".
- Session timeouts/errors and regressions are hidden.
- report-only findings have been mixed with secrets in orchestrator state.
- exitStatus can be non-zero while secrets are zero and left is zero, confusing users.

Files to inspect:
- src/orchestrator.ts
- src/findings/router.ts
- src/report/schema.ts
- src/report/builder.ts
- src/output/summary.ts
- src/commands/retry.ts
- src/orchestrator.test.ts
- src/output/summary.test.ts
- src/report/builder.test.ts

Implement:
1. Separate state maps in orchestrator:
   - secrets
   - reportOnly
   - deterministic
   Do not store report-only findings in `secrets`.
2. Add report fields if needed:
   - reportOnly
   - runFailures or failureSummary
   - unresolvedEligibleCount
3. Exit status rules:
   - 0 only when there are no blocking secrets, unresolved eligible findings, tool failures, or failed deterministic fixes.
   - non-zero when any blocking class remains.
   - report-only unsupported findings should be configurable: default warning unless severity/category indicates blocking security/secret.
4. Replace `findingReason()` behavior:
   - reverted => exact revert reason label
   - unfixable + session-error => session error / timeout
   - unfixable + regression => regression introduced
   - unfixable + typecheck => typecheck failed
   - unfixable + broke-test => tests failed
   - unfixable without detail => retries exhausted
5. Render top-level buckets:
   - fixed
   - skipped tests
   - skipped generated
   - skipped fixtures
   - report only
   - timed out/session error
   - regressed
   - typecheck failed
   - test failed
   - unresolved eligible
6. In the "couldn't fix" table, include revertDetail first line for actionable diagnosis.

Acceptance criteria:
- A report with `revertReason: session-error` and detail `Claude session failed (exit 143)` renders as timeout/session error, not exhausted retries.
- Cross-file jscpd report-only duplicates do not appear in secrets.
- Non-zero exit status has a visible matching reason in summary.

Tests:
- Add focused summary tests for session error, regression, typecheck, test failure, and report-only.
- Add orchestrator test proving report-only is not stored as secret.
- Run:
  - pnpm exec vitest run src/orchestrator.test.ts src/output/summary.test.ts src/report/builder.test.ts --reporter=dot
  - pnpm run typecheck
```

## Session 3: Repair Strategy Planner

```text
Task: Add a repair planner that classifies findings into concrete fix strategies before dispatch.

Problem:
- Tend currently routes mostly by scanner track.
- That makes jscpd, dead-code, generated files, tests, and semantic refactors all go through the same generic AI prompt.

Files to inspect:
- src/findings/finding.ts
- src/findings/router.ts
- src/fixing/dispatch.ts
- src/fixing/fix-unit.ts
- src/orchestrator.ts
- src/report/schema.ts
- test/helpers/make-finding.ts

Implement:
1. Add `src/fixing/repair-strategy.ts`.
2. Define strategies:
   - deterministic-eslint-fix
   - deterministic-ts-organize-imports
   - deterministic-package-json-cleanup
   - single-file-ai-edit
   - multi-file-duplicate-refactor
   - generated-source-repair
   - test-file-repair
   - unsupported
3. Planner inputs:
   - finding
   - scope policy metadata
   - config flags includeTests/includeGenerated/includeFixtures
   - flowPath
   - file path/category/rule/tool
4. Planner outputs:
   - strategy
   - editableFiles
   - verificationTargets
   - reason when unsupported
5. Required classifications:
   - jscpd same-file duplicate => single-file-ai-edit or duplicate-specific same-file strategy
   - jscpd cross-file duplicate with two editable source files => multi-file-duplicate-refactor
   - jscpd cross-file duplicate with generated/fixture file excluded => generated/fixture excluded reason
   - eslint/sonar rules with known autofix metadata => deterministic-eslint-fix
   - unused imports => deterministic-ts-organize-imports
   - package.json unused dependency => deterministic-package-json-cleanup
   - test file finding with includeTests => test-file-repair
   - generated file finding => generated-source-repair if source owner found, otherwise unsupported generated-source-not-found
6. Orchestrator should dispatch work units by planned strategy, not raw file only.

Acceptance criteria:
- Strategy is visible in report findings.
- Strategy is visible in verbose/plain output.
- Existing AI flow still works through `single-file-ai-edit`.

Tests:
- Add repair-strategy unit tests covering all strategies above.
- Add dispatch/orchestrator tests proving cross-file jscpd produces a multi-file unit.
- Run:
  - pnpm exec vitest run src/fixing/repair-strategy.test.ts src/orchestrator.test.ts --reporter=dot
  - pnpm run typecheck
```

## Session 4: Deterministic Fixers Before AI

```text
Task: Implement deterministic fixers and run them before AI.

Problem:
- Tend spends Claude sessions on mechanical edits that established tools can fix faster and safer.

Files to inspect:
- src/scanners/eslint-sonarjs.ts
- src/fixing/fix-unit.ts
- src/orchestrator.ts
- src/gate/checks/*
- src/session/*
- package.json

Implement:
1. Add deterministic fixer interface:
   - input: planned repair unit
   - output: FixOutcome with changed files and usage zero
2. ESLint fixer:
   - Use ESLint Node API with `fix` / `fixTypes` / fix predicate.
   - Apply fixes only for findings in the current unit.
   - Use `ESLint.outputFixes(results)`.
3. TypeScript organize imports fixer:
   - Use TypeScript language service or a stable library already acceptable in this repo.
   - Apply only to target files.
   - Use for unused imports/import cleanup.
4. package.json cleanup fixer:
   - Remove unused dependency/devDependency only when finding is exact and package manager lockfile handling is safe.
   - If lockfile update is required and not implemented, mark `needs-lockfile-update` clearly.
5. Run deterministic fixers before AI in each loop.
6. Gate deterministic changes with the same safety pipeline:
   - anti-suppression where relevant
   - typecheck
   - tests
   - targeted re-scan

Acceptance criteria:
- Mechanical fixes do not consume AI usage.
- ESLint autofixable findings are fixed without Claude.
- If deterministic fix fails, report exact reason and do not fall through to AI unless strategy explicitly allows fallback.

Tests:
- Add tests for deterministic fixer success and failure.
- Add usage test proving deterministic fixes add zero AI sessions.
- Run:
  - pnpm exec vitest run src/fixing/deterministic*.test.ts src/orchestrator.test.ts --reporter=dot
  - pnpm run typecheck
```

## Session 5: Multi-file jscpd Duplicate Repair

```text
Task: Make cross-file jscpd duplicates actually fixable with multi-file repair units.

Problem:
- Cross-file duplicates currently become report-only or fail through a one-file prompt.
- Tend's product promise requires attempting valid multi-file refactors.

Files to inspect:
- src/scanners/jscpd.ts
- src/findings/normalize.ts
- src/findings/router.ts
- src/fixing/dispatch.ts
- src/fixing/fix-unit.ts
- prompts/fix.md
- src/gate/checks/anti-regression.ts

Implement:
1. Keep jscpd `flowPath` with both clone sites.
2. For cross-file duplicates where both files are in fix scope, create one multi-file repair unit containing both files.
3. Add prompt template `prompts/multi-file-duplicate-refactor.md`.
4. Prompt requirements:
   - include both clone regions
   - require behavior-preserving extraction/consolidation
   - forbid deleting one clone unless it is provably dead code
   - require imports/exports to remain valid
5. Gate:
   - typecheck
   - tests
   - re-run jscpd against affected files or affected scope
   - reject if original clone still exists or new clone regression appears
6. If files are excluded by scope policy, classify as skipped-by-scope, not report-only.

Acceptance criteria:
- Cross-file jscpd duplicates in source files are attempted as multi-file units.
- Cross-file jscpd duplicates in excluded files are reported with exact exclusion reason.
- Same-file duplicates still work.

Tests:
- Add fixture with two source files containing duplicate code.
- Assert planner creates multi-file unit.
- Assert prompt includes both files and both ranges.
- Add orchestrator test with fake fixUnit proving both files are editable.
- Run:
  - pnpm exec vitest run src/scanners/jscpd.test.ts src/fixing/repair-strategy.test.ts src/fixing/fix-unit.test.ts src/orchestrator.test.ts --reporter=dot
  - pnpm run typecheck
```

## Session 6: Generated Source Repair

```text
Task: Implement generated-source repair so Tend fixes source instead of hand-editing generated artifacts.

Problem:
- Generated files can appear in reports.
- Hand-editing generated files is wrong.
- Tend must find source owners or report that it cannot.

Files to inspect:
- src/scanners/*
- src/detect/*
- src/fixing/*
- src/bin.ts
- tsdown.config.ts
- package.json

Implement:
1. Add generated file detection:
   - dist/build/out paths
   - emitted .d.ts/.d.ts.map under generated output
   - files with sourceMappingURL if source map exists
2. Add source owner resolver:
   - source maps when available
   - package build config when obvious
   - TypeScript declaration map when available
3. Strategy:
   - generated finding + source owner found => generated-source-repair with editable source file(s)
   - generated finding + no owner => generated-source-not-found
4. Generated-source prompt:
   - never edit generated artifact directly
   - fix source owner
   - run project build after fix
5. Gate:
   - run build command if configured/detected
   - re-scan source and generated artifact

Acceptance criteria:
- Finding in `dist` is not sent to generic AI edit.
- If source owner exists, Tend edits source and runs build.
- If source owner is missing, report says generated-source-not-found.

Tests:
- Add tests for generated detection and source map owner resolution.
- Add planner tests.
- Run:
  - pnpm exec vitest run src/fixing/generated-source*.test.ts src/fixing/repair-strategy.test.ts --reporter=dot
  - pnpm run typecheck
```

## Session 7: Adaptive Timeout And Regression Retry

```text
Task: Stop wasting attempts on killed sessions and make regression retries adaptive.

Problem:
- `Claude session failed (exit 143)` currently consumes normal per-issue retries.
- The same prompt shape is retried until budget is exhausted.
- Regression retries do not include enough structured failure context.

Files to inspect:
- src/session/claude.ts
- src/fixing/fix-unit.ts
- src/orchestrator.ts
- src/findings/store.ts
- src/gate/checks/*
- prompts/fix.md

Implement:
1. Classify session failures:
   - timeout / killed / exit 143
   - rate limit
   - model/tool failure
   - no edit
2. Retry policy:
   - timeout first occurrence => split unit smaller if possible
   - timeout second occurrence => mark tool-timeout, do not consume all issue retries
   - rate limit => stop run with clear retryable infrastructure status
   - no edit => retry once with stricter prompt, then mark no-op
3. Regression retry:
   - include rejected diff summary
   - include exact new findings
   - include typecheck/test output first relevant lines
   - reduce unit size where possible
4. Add prompt template `prompts/regression-repair.md`.
5. Store final failure class in report.

Acceptance criteria:
- Exit 143 renders as timeout/tool failure and does not show as exhausted retries.
- Retrying after regression receives exact details.
- A timed-out multi-finding unit is split before retry.

Tests:
- Unit tests for session failure classification.
- Orchestrator tests for timeout split/no repeated burn.
- Fix-unit tests for regression repair prompt detail.
- Run:
  - pnpm exec vitest run src/session/*.test.ts src/fixing/fix-unit.test.ts src/orchestrator.test.ts src/output/summary.test.ts --reporter=dot
  - pnpm run typecheck
```

## Session 8: Strategy-specific Prompt Templates

```text
Task: Replace the single generic fix prompt with strategy-specific templates.

Problem:
- Current `prompts/fix.md` is generic and self-defeating for multi-file and generated-source work.

Files to inspect:
- prompts/fix.md
- src/fixing/fix-unit.ts
- src/fixing/repair-strategy.ts
- src/session/types.ts
- src/fixing/fix-unit.test.ts

Implement prompt templates:
1. `prompts/single-file-ai-edit.md`
2. `prompts/multi-file-duplicate-refactor.md`
3. `prompts/test-file-repair.md`
4. `prompts/regression-repair.md`
5. `prompts/generated-source-repair.md`
6. `prompts/dead-code-cleanup.md`

Each prompt must include:
- strategy name
- findings JSON
- editable files
- verification targets
- explicit forbidden shortcuts
- exact success condition

Rules:
- Multi-file duplicate prompt must allow and require editing all clone files.
- Generated-source prompt must forbid direct generated artifact edits.
- Dead-code prompt must prefer deletion/package cleanup when behavior-preserving.
- Test prompt must forbid weakening assertions and require old-code failure if tests are changed.
- Regression prompt must include failure details.

Acceptance criteria:
- FixUnit chooses prompt by strategy.
- Tests snapshot/render each prompt with representative findings.
- Generic `fix.md` is either removed or kept only as fallback with explicit deprecation.

Tests:
- Add prompt rendering tests.
- Run:
  - pnpm exec vitest run src/fixing/fix-unit.test.ts --reporter=dot
  - pnpm run typecheck
```

## Session 9: End-to-end Bad Report Regression

```text
Task: Add an end-to-end regression fixture based on the bad report behavior so Tend cannot regress into this mess again.

Context:
- The bad run showed:
  - dist findings attempted
  - fixtures attempted
  - report-only jscpd mixed with secrets/exit status
  - timeout/session errors rendered as exhausted retries
  - 75 minutes spent for mostly failed work

Files to inspect:
- .tend/report.json if present
- test/fixtures
- src/output/summary.test.ts
- src/orchestrator.test.ts
- src/commands/commands.test.ts

Implement:
1. Add a compact JSON fixture under `test/fixtures/reports/bad-run-scope-and-timeouts.json`.
2. It must include:
   - dist generated finding
   - test fixture finding
   - report-only cross-file jscpd duplicate
   - session-error exit 143 unfixable
   - regression unfixable
   - normal source finding
3. Add tests proving:
   - generated/fixture findings are not eligible by default
   - report-only is not secret
   - session error renders as timeout/session failure
   - exit status explanation matches the visible blocking buckets
4. Add a docs note explaining reportScope vs fixScope.

Acceptance criteria:
- The fixture fails against the old behavior and passes against the new behavior.
- The final summary is understandable without inspecting raw JSON.

Tests:
- pnpm exec vitest run src/output/summary.test.ts src/orchestrator.test.ts src/commands/commands.test.ts --reporter=dot
- pnpm run typecheck
```

## How To Avoid More Back And Forth

Use this operating rule for every future Tend implementation session:

```text
Do not propose. Implement.

Start by adding failing tests that encode the product behavior.
Then implement the smallest architecture change that makes those tests pass.
End with exact verification commands and a list of remaining intentionally unimplemented strategies.

If a finding class is not fixable yet, do not hide it. Add a named strategy state and report it truthfully.
```

Use this acceptance checklist before merging any repair-engine change:

- The report names the exact reason a finding was not fixed.
- No AI session runs on files outside fixScope.
- Deterministic fixers run before AI.
- Cross-file findings become cross-file units.
- Generated artifacts are fixed through source or marked source-not-found.
- Timeouts are tool failures, not code failures.
- Regression retries include exact failure context.
- Tests cover report JSON and rendered summary.
