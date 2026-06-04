# tend — Spec

> An open-source CLI that audits a JS/TS repo with established scanners, then fixes the findings with parallel `claude -p` sessions in a safe scan→fix→rescan loop. Tend your code now so it never becomes an overgrown mess.

## Purpose

Run after making changes. The tool audits the repo, fixes what it safely can with AI, re-audits, and loops until clean or capped. It never commits — fixes are left as uncommitted edits for the dev to review.

## Principles

- **Detect & defer, never assume.** Zero hardcoded framework assumptions (no "Next.js detection"). Detect package manager, TS/JS, test runner, and existing tool configs; defer to them.
- **Don't reinvent the wheel.** Thin glue over mature libraries; scanners are invoked, never reimplemented.
- **Never corrupt the oracle.** Tests define behavior; the tool may fix them but can never silently weaken them.
- **Fail safe.** A fix lands only if it passes every gate; otherwise it's reverted. Worst case is "changed nothing," never "broke your code."

## Tool routing

Six scanners, three categories:

| Category | Tools | Action |
|----------|-------|--------|
| **AI fix loop** | `eslint`+`sonarjs`, `knip`, `jscpd`, `semgrep` | Findings fed to AI sessions to fix |
| **Deterministic** | `osv-scanner` | Dependency version bumps (guided remediation), no AI |
| **Report-and-halt** | `gitleaks` | Secrets surfaced loudly, **never** AI-touched; exit non-zero. Code fixes still proceed. |

## Engine (libraries)

| Concern | Library |
|---------|---------|
| Worker pool + concurrency cap | `p-queue` |
| Subprocesses (scanners + `claude -p`) | `execa` |
| All git operations | `simple-git` |
| Live parallel-session UI | `listr2` |
| Colors | `chalk` |
| Gradient text | `gradient-string` (`pastel` preset) |
| Summary box | `boxen` |
| Summary table | `cli-table3` |
| Cross-platform glyphs | `log-symbols` |
| Report schema + validation | `zod` |
| Config discovery | `cosmiconfig` |
| CLI parsing | `commander` |

## The loop

```
snapshot working tree (silent restore point)
audit (all 6 tools) → normalize → report.json
  ├─ secrets? surface, exclude from fixes, mark run non-zero
  ├─ deps? deterministic bump pass
  └─ code-quality findings ↓
group findings by file → p-queue dispatches one session per file (disjoint files)
each fix runs the gate (below); pass → keep, fail → revert
re-audit
  └─ converged (0) | max-loops | no-progress | per-issue budget exhausted → stop
     else loop
```

- Re-audit once per loop (after the whole parallel batch), not per session.

## Finding model & tracking

One source of truth: a collection of `Finding` records keyed by a stable **fingerprint**, persisted to `.tend/report.json`. Every scanner's raw output is normalized into this shape, and the same records carry state across every loop.

**Fingerprint** = `hash(tool | rule | file | line | message)`. It gives each issue a stable identity, which enables dedupe, cross-loop tracking, and the per-issue attempt budget.

```ts
type Finding = {
  id: string              // fingerprint: hash(tool|rule|file|line|message)
  tool: 'sonarjs' | 'knip' | 'jscpd' | 'semgrep' | 'osv' | 'gitleaks'
  rule: string            // e.g. 'no-identical-expressions', semgrep rule id
  category: 'bug' | 'smell' | 'dead-code' | 'duplication'
            | 'security' | 'secret' | 'vuln-dep'
  severity: 'error' | 'warning' | 'info'
  file: string            // repo-relative
  range: { startLine: number; startCol: number; endLine: number; endCol: number }
  message: string         // scanner's description
  helpUri?: string        // rule docs link
  flowPath?: { file: string; line: number }[]  // semgrep taint: source → sink
  remediation?: string    // osv: the exact version bump

  track: 'ai-fix' | 'deterministic' | 'report-only'

  // state — evolves across loops
  status: 'pending' | 'fixing' | 'fixed' | 'reverted' | 'unfixable' | 'skipped'
  attempts: number                       // drives the per-issue budget
  revertReason?: 'broke-test' | 'suppression' | 'regression'
              | 'typecheck' | 'session-error'
  firstSeenLoop: number
  lastSeenLoop: number
}
```

**Reconciliation each loop** — the store diffs the fresh audit against what it knows, by fingerprint:

```
in store last loop, ABSENT now  → mark fixed
present BOTH loops               → still pending (carry attempts + history)
NEW fingerprint                  → newly introduced (anti-regression should
                                   have caught it; else pre-existing, revealed)
```

The loop is literally a diff of successive audits against this store; `report.json` is the store serialized.

## Scope (per-tool hybrid)

Two separate questions: **what we scan** and **what we fix**.

**Fixing** is the expensive part (AI sessions cost time + tokens), so by default tend only fixes findings in **files changed vs `HEAD`**. `--all` fixes the entire backlog. Passing one or more paths — `tend run <path...>` — fixes only findings under those files/dirs regardless of git status (each path is expanded to its concrete tracked + untracked files via `git ls-files`). Either way the full finding set is reported in `report.json`.

The fix scope is resolved once, up front, as a single file list (or "whole repo" for `--all`), then drives three things in lockstep: the test baseline, the diff-aware scanners' targets, and the final fix filter. The three sources are mutually exclusive — `--all` wins over paths, paths win over the changed-files default.

**Scanning** is cheap (seconds), so each tool runs in the most correct mode available — diff-aware where it's free and correct, whole-repo where correctness requires it:

| Tool | Scan scope | How |
|------|-----------|-----|
| `eslint`+`sonarjs` | changed files | per-file analyzer; pass changed paths |
| `semgrep` | changed (native) | `--baseline-commit` / `SEMGREP_BASELINE_REF` — reports only newly-introduced findings |
| `gitleaks` | changed (native) | `--staged` / commit range |
| `osv-scanner` | whole (cheap) | reads lockfile + DB; not file-scoped |
| `knip` | **whole repo** | needs full module graph for correctness; `--cache` on; **filter findings to changed files** after the scan |
| `jscpd` | **whole repo** | scoping to changed files would miss clones against unchanged files |

The two whole-repo tools (`knip`, `jscpd`) follow **scan wide, fix narrow** — scan everything for correct results, then filter findings to changed files (unless `--all`). Net: same default behavior as the diff-aware tools — only issues in your changed files get fixed.

## Parallelism

- Findings grouped by file; each worker owns a **disjoint set of files** (incl. that file's sibling test). No two sessions touch the same file.
- Max concurrent sessions = configurable cap (default `min(cpus-ish, cap)`), enforced by `p-queue`.

## Git safety model

- **In-place edits.** No worktrees, no branches — operates on the dev's actual files (which is what they want audited).
- **Silent snapshot at start** (full tracked + untracked state, via `simple-git`) as an invisible restore point. Nothing committed, editor sees no change.
- `tend diff` — shows **only the tool's edits** (snapshot vs now; the dev's own changes filtered out).
- `tend undo` — restores the snapshot exactly.
- **Result left as uncommitted edits.** Tool never writes git history; dev reviews and commits.
- Must be a git repo (the restore path); refuse otherwise.

## Verification gate (per fix)

A fix is the **atomic change-set** for one file: the code file *and* its sibling test, applied/reverted together.

1. **Anti-suppression** — reject if the edit added `eslint-disable` / `@ts-ignore` / `@ts-nocheck`, cast to `any`, or deleted code instead of fixing it.
2. **Anti-regression** — reject if the fix introduced a *new* finding. No lateral moves: the fix must strictly reduce findings, never trade one issue for another. This is what guarantees the loop converges instead of oscillating.
3. **Typecheck** — `tsc --noEmit` (skipped if no `tsconfig`).
4. **Tests** — see below.

Any failure → revert the whole change-set, mark the finding as a failed attempt.

## Test handling

Tests are the **behavior oracle**. Detect the command: `package.json` `scripts.test` → config-file detection (vitest/jest) → `test:` config override. Run **related tests only** (vitest `--related` / jest `--findRelatedTests`). E2E/Playwright excluded from the gate. Test files excluded from fix scope by default (`--include-tests` to opt in).

**Baseline:** run the suite once at start; record green tests. Pre-existing failures are ignored.

**Per-fix flow when a test is involved:**

```
1. Apply code fix → run related test(s)
     • GREEN, no test touched → keep
     • RED → open repair window
2. REPAIR WINDOW (bounded, ~3 attempts): AI diagnoses the failure and edits
   CODE (wrong fix) and/or TEST (structural: moved import/extracted fn), re-runs
     • exhausted, still RED → revert + report
     • GREEN → final gates
3. FINAL GATES: anti-suppression + tsc + (if a test was edited) TEETH CHECK
```

**Teeth check (anti oracle-corruption):** when the AI edited a test, run that test against the **old (pre-fix) code** — it must **fail**. If it passes on both old and new code it asserts nothing → reject the change-set. Default-on (config flag to disable for speed).

Test edits are classified: **structural** (imports/mocks/paths) allowed freely; **semantic** (changed assertion/expected value) must pass the teeth check **and** is flagged in the report for human review.

**No test suite:** gate degrades to anti-suppression + `tsc`; warn that behavior can't be verified. (Opt-in golden-master/characterization snapshots: later.)

## Termination

Stop when any holds:
- **Converged** — 0 fixable findings.
- **Max loops** — configurable cap.
- **No progress** — a full loop resolved nothing.
- **Per-issue budget** — a fingerprinted finding survived N loops → mark unfixable, keep going on the rest.

Findings fingerprinted (`tool|rule|file|line|message`) to dedupe and track across loops.

## Edge cases

Where edge cases occur and how each is handled.

**Preflight (environment):**

```
tend run
   │
   ▼
┌ git repo? ─────── no ──► ERROR "not a git repo" ─► EXIT
│ yes
▼
take SILENT SNAPSHOT (tracked + untracked)  ◄─ restore point for `tend undo`
   │
   ▼
detect: package manager · TS? (tsconfig) · test runner · existing tool configs
   │
   ▼
┌ per scanner: binary present?
│   ├─ ALL missing ──► ERROR "nothing to run" ─► EXIT
│   └─ SOME missing ─► skip them + print install hint ─► continue
▼
proceed to AUDIT
```

**Post-audit (finding-type routing):**

```
AUDIT (6 tools) ─► normalize ─► findings
   │
   ├─ gitleaks SECRET ─────► surface LOUDLY · never fix · exit code = non-zero
   │                          (does NOT block the code fixes below)
   ├─ osv VULNERABLE DEP ──► deterministic version-bump pass (no AI)
   ├─ 0 code findings ─────► REPORT ─► EXIT (clean)
   └─ code findings ──────► filter to CHANGED files (unless --all)
                              └─► group by file ─► DISPATCH (p-queue)
```

**Per-fix gate (one worker, file `F` + its sibling test):**

```
AI edits F  ─►  re-scan F's class + run related test(s)
   │
   ├─ session crashed / errored ──────────────────► REVERT ─► failed attempt
   ├─ rate-limited ──► backoff + reduce concurrency ─► retry
   ├─ fix introduced a NEW finding (anti-regression) ─► REVERT (no lateral moves)
   │
   ├─ test GREEN & no test touched ───────────────┐
   └─ test RED ─► REPAIR WINDOW (≤ N tries) ───────┤
        AI: wrong code → edit code                 │
            moved structure → edit test            │
        re-run ↺                                    │
          ├─ still RED after N ──► REVERT ─► failed attempt
          └─ now GREEN ──────────────────────────►─┤
                                                    ▼
                              ┌──────── FINAL GATES ────────┐
                              │ a. anti-suppression          │ ─fail─► REVERT
                              │ b. tsc --noEmit (skip if JS)  │ ─fail─► REVERT
                              │ c. teeth check (if test edited)│
                              │    new test must FAIL on OLD   │ ─pass on
                              │    code; else rubber stamp     │  both─► REVERT
                              └───────────────┬───────────────┘
                                          all pass
                                              ▼
                                    KEEP fix (flag if semantic test change)
```

Every `REVERT` restores that file's change-set atomically (code + sibling test) and records a failed attempt against the finding's fingerprint.

**Loop termination (after each batch, re-audit once):**

```
re-audit ─► compare to previous report
   │
   ├─ 0 findings left ─────────────► STOP · converged
   ├─ this loop fixed NOTHING ─────► STOP · no-progress
   │     (also catches oscillation: fix A→create B→fix B→create A nets zero)
   ├─ a finding failed N loops ────► mark UNFIXABLE · keep going on the rest
   ├─ max loops reached ───────────► STOP · report remaining
   └─ otherwise ──────────────────► LOOP AGAIN ↺
```

## CLI

```
tend                # snapshot → audit → fix loop → report (changed files)
tend run <path...>  # fix only findings under these files/dirs (committed or not)
tend --all          # fix entire backlog, not just changed files
tend diff           # show only the tool's edits
tend undo           # restore pre-run snapshot
tend show <id>      # full detail on one finding (attempts, flow path, diffs tried)
tend retry <id>     # re-attempt a stubborn finding with a larger budget
```

## Config (`cosmiconfig`, zero-config default)

- `maxSessions`, `maxLoops`, `perIssueBudget`
- `test` (command override), `teethCheck` (bool), `includeTests` (bool)
- per-tool enable/disable + config path overrides

## Output & DX

Two surfaces: the **live terminal UI** while running, and the **machine-readable report**.

**Color language (consistent everywhere):** green = fixed/kept · yellow = left/unfixable · red = reverted · **red-bold = secret** · dim = queued · `pastel` gradient reserved for the banner + headline summary numbers.

**While running** (`listr2` task tree, live spinners):

```
   ╭───────────────────────────────╮
   │   t e n d                      │   figlet + gradient-string
   ╰───────────────────────────────╯

  ✔ Snapshot saved          your work is safe · undo: tend undo
  ✔ Detected                pnpm · TypeScript · vitest
  ✔ Audit                   6 scanners · 23 findings · 9 files

  ⠹ Fixing                  loop 1 · 6/9 files · 6 workers
     ✔ src/auth/login.ts          2 fixed
     ⠹ src/api/client.ts          fixing… (sonarjs, jscpd)
     ⠹ src/db/schema.ts           running tests…
     ◷ src/components/nav.tsx     queued
     ✖ src/legacy/parse.ts        reverted · broke a test
```

**Final summary** (`boxen` + `cli-table3` + gradient headers): headline counts (fixed / left / secrets / loops / time), a per-tool breakdown table (fixed / reverted / left, deps bumped, secrets to rotate), and next-step hints (`tend diff`, `tend undo`, report path).

**Actionable remaining issues.** Zero left → say so and celebrate. Otherwise, the key move is to **group remaining issues by *why* tend couldn't fix them** — that's what tells the dev what to do — ordered by urgency (secrets → security → couldn't-fix → needs-review):

```
  3 issues need you

  ⚠ SECRETS — rotate now (never auto-fixed)
    1. config/prod.ts:14    AWS access key            [gitleaks]
       → revoke + rotate the key, then scrub history
       this is urgent; the key is already in git history

  ✖ COULDN'T FIX after 3 tries
    2. src/legacy/parse.ts:88   cognitive complexity 41 > 15   [sonarjs]
       why: every refactor broke parse.test.ts:30
       → split this function by hand  ·  details: tend show 2
       docs: https://…/cognitive-complexity

  ● NEEDS YOUR REVIEW — behavior changed
    3. src/api/auth.ts:52   fix changed a test expectation   [semgrep]
       → confirm the new behavior is intended  ·  tend diff src/api/auth.ts
```

Each line carries: clickable `file:line`, the rule, the **`why`** (for unfixable issues, the failure reason from `revertReason`/attempt history — the most useful thing for a human), a one-line recommended action, and a docs link (`helpUri`).

Drill-down / escape hatches:
- `tend show <id>` — full record for one finding: flow path, every attempt tend made and how each failed, the diffs it tried.
- `tend retry <id>` — re-attempt a stubborn finding with a larger attempt budget (a fresh session sometimes cracks it).
- `report.json` — machine-readable, for CI or piping to the dev's own editor/agent.

**`report.json`** (zod-validated, machine-readable): findings, per-finding outcome (fixed / failed / unfixable / skipped / reverted-reason), secrets surfaced, dependency bumps, flagged behavior changes, loop count, timings, exit status.

## Packaging & distribution

Developed here, extracted later — so it's built as a **self-contained leaf** from day one.

**Location:** `packages/tend/` (auto-included by the `packages/*` workspace glob).

**Self-contained rules (what makes migration one command):**
- **No `@ajiri/*` / workspace dependencies** — only external npm deps; never imports from the monorepo.
- **Own `tsconfig.json`** — no `extends` from the root.
- **Own** `package.json` (`bin` · `exports` · `files` · `engines`), build config (`tsdown`), `vitest` config, `README`, and **MIT `LICENSE`**.
- **Brand-neutral** — no "Ajiri" references anywhere.
- **Docs live in `packages/tend/docs/`** so they travel with the package.

**Extraction:** `git subtree split --prefix=packages/tend -b tend-standalone` → push to new repo → publish. No untangling.

**Distribution:** one registry (npmjs.com); pnpm/npm/yarn/bun all install from it. Publish once (`npm publish` / `pnpm publish`). Package name: **`tend-cli`** (unscoped; `tend` is taken), bin command **`tend`** — so `npx tend-cli@latest` for a registry one-off, and `tend` after an install. The package and executable names intentionally do not need to match. (Optional later: also publish to JSR.)

**Build:** ESM, Node ≥ 20, `tsdown` → `dist/` with a shebang'd `bin/tend` entry so `npx` works.
