# Task: add `tend run <path...>` (path-scoped fixing)

Work in `packages/tend/` (npm `tend-cli`, bin `tend`). Self-contained leaf: no `@ajiri/*`,
brand-neutral. Verify from that dir: `pnpm test` (baseline 40 files / 210 tests green),
`pnpm typecheck`, `pnpm build`.

## Goal
```
tend run <path...>   # NEW: fix only findings under these files/dirs (committed or not)
tend run             # unchanged: files changed vs HEAD
tend run --all       # unchanged: whole backlog
```
Motivating case: the WhatsApp code is already committed, so plain `tend run` finds nothing
(clean tree) and `--all` scans the whole repo. The user wants:
`tend run "apps/dashboard/app/(app)/api/whatsapp" "apps/dashboard/lib/channels/whatsapp"`
to fix only that subtree.

## Verified architecture — CONFIRM by reading these, don't trust blindly
Two orthogonal scope axes (`docs/TEND_SPEC.md:104-121`):

1. **What each scanner scans** — hardcoded per scanner, NOT one global flag:
   - `src/scanners/knip.ts:40`, `jscpd.ts:69`, `osv.ts:37`, `gitleaks.ts:21` → always whole
     repo / full history; ignore `ctx.files`.
   - `src/scanners/eslint-sonarjs.ts:60` (`runEslintSonarjs`) and `semgrep.ts:51` → scan
     **exactly `ctx.files`** (fallback `["."]` if empty).
2. **What gets fixed** — `inScope` predicate: `src/bin.ts:294` → `src/orchestrator.ts:105,126`.
   `--all` = identity; otherwise `filterToChanged(_, changed)` (`src/scanners/scope.ts:26-35`,
   exact `f.file` match; duplication keeps the clone if either flowPath side is in scope).

One list `changed` drives THREE things: eslint/semgrep scan targets (`src/scanners/all.ts:110`),
the test baseline (`src/bin.ts:260` → `runTests`, `bin.ts:122-124`), the fix filter (`bin.ts:294`).

### The wrinkle (important)
`buildAudit` does NOT receive `changed` from `bin.ts` — it re-derives it itself via
`changedVsHead(deps.git)` at `src/scanners/all.ts:109`, taking only `all: boolean` in
`AuditDeps`. So a path-scope cannot be threaded through `inScope` alone — `buildAudit` must be
changed to accept the resolved scope list instead of recomputing it.

### Spec/code drift to be aware of (do NOT fix here)
`TEND_SPEC.md:115-116` claims semgrep uses `--baseline-commit` and gitleaks uses `--staged`.
The code does neither (semgrep takes `ctx.files`; gitleaks scans full history). Out of scope.

## Design — make `<path...>` a third source for the scope list (parallel to `changed`)
1. `src/cli.ts` — add positional `[paths...]` to the `run` command; add `paths?: string[]` to
   `CliHandlers.run` opts; pass through.
2. New helper `filesUnder(git, paths: string[]): Promise<string[]>` in `src/git/repo.ts` —
   expand each dir/file to concrete repo-relative files via `git ls-files`, scoped/re-based to
   git's cwd exactly like `changedVsHead` (`repo.ts:28-38`, `--show-prefix`). MUST expand to
   files (not a bare dir) because `filterToChanged` matches exact paths, not prefixes. Include
   untracked (`git ls-files -o --exclude-standard`) to mirror `changedVsHead`.
3. `src/bin.ts` (`runRun`) — resolve scope once: `--all` → null; else `opts.paths?.length` →
   `await filesUnder(git, opts.paths)`; else → `await changedVsHead(git)`. Feed that single list
   to `baselineTargets`, the audit, and `inScope`. Update the scope note (`bin.ts:270-273`). If
   paths were given but expand to zero files: print `✖ no files under <paths>`, set
   `process.exitCode = 1`, return.
4. `src/scanners/all.ts` — change `buildAudit` to receive the resolved scope list (or null =
   whole repo) instead of re-deriving `changedVsHead`. Update `AuditDeps` and all callers/tests.
5. Docs — update `docs/TEND_SPEC.md` CLI section (`:266-275`) and Scope section (`:104-121`);
   add `T-NNN` checklist entry/entries to `docs/TEND_IMPLEMENTATION.md` matching its numbering.

Net: scanners still scan wide for correctness (knip/jscpd/osv/gitleaks unaffected); findings are
reported wide but **fixed only under the given path(s)**.

## Method — strict TDD (red → green → refactor), one test at a time
Write ONE failing test, run it, see it fail for the right reason, make it pass minimally, then
next. Tests assert behavior with explicit setup/invocation/assertions; expected values come from
the spec/fixtures, never from implementation output. Suggested order:
1. `filesUnder` expands a directory to its files, repo-relative, scoped to cwd (cover a subdir +
   a single file + a no-match path).
2. `cli.ts` parses `run <path...>` positionals into `opts.paths`.
3. `buildAudit` uses an injected scope list rather than re-deriving from git.
4. With a path scope, a finding OUTSIDE the path is reported but NOT fixed; one INSIDE is fixed.
Mirror existing patterns/helpers (`src/**/*.test.ts`, `test/helpers/tmp-repo.ts`).

## Constraints (hard requirements)
- NO Claude/AI attribution anywhere — code comments, commit messages, PR text, docs. Brand-neutral
  (no "Ajiri").
- Match surrounding style, comment density, idioms. ESM relative imports with `.js` extensions.
- Thin glue over `simple-git` / `commander`; package stays self-contained (external npm deps only).
- Do NOT run `tend run` against the monorepo as a "test". Verify only via `pnpm test`,
  `pnpm typecheck`, `pnpm build` in `packages/tend/`.
- Do not commit unless asked. If asked, branch first if on a default branch; keep changes to
  `packages/tend/`.

## Definition of done
- `tend run <path...>` fixes only findings under the given paths; `tend run` and `tend run --all`
  behavior unchanged.
- New + existing tests green (`pnpm test`); `pnpm typecheck` and `pnpm build` pass.
- `TEND_SPEC.md` + `TEND_IMPLEMENTATION.md` updated.
- Report: files changed, new tests added, and the exact command that scopes to the WhatsApp dirs.
