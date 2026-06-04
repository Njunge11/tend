# tend — Implementation (TDD checklist)

Build plan for `packages/tend/`. Read [`TEND_SPEC.md`](./TEND_SPEC.md) first. Work the checklist **top to bottom** — modules are ordered so each only depends on ones already built.

## TDD workflow (follow exactly)

For each test case `T-xxx`, in order:

1. **Red** — write the one test. Run it. Watch it fail.
2. **Green** — write the minimum code to make it pass. Nothing more.
3. **Refactor** — clean up if needed; tests stay green.
4. **Only then** move to the next test.

Rules:
- One test at a time. Never write code with no failing test demanding it.
- Test **behavior**, not implementation. Expected values come from the spec or a fixture — **never** from running the code and copying its output.
- Each test is explicit: arrange (setup) → act (invoke) → assert.
- Keep `[ ]` / `[x]` updated as you go.

## Conventions

- **Unit tests co-located**: `foo.ts` → `foo.test.ts` beside it.
- **Fixtures** in `test/fixtures/`: `scanner-outputs/` (frozen tool JSON — parse without running the binary) and `repos/` (tiny seeded git repos for loop tests).
- **Fakes** in `test/helpers/`: `fakeSession()`, `fakeScanner()`, `tmpRepo()`. The loop is tested with the fake session — never a real `claude -p`.
- **Two interfaces only**: `Scanner` and `SessionRunner`. Everything else concrete, dependencies passed in.
- Vitest + TypeScript (strict). ESM. Node ≥ 20.

## File structure

```
packages/tend/
├── src/
│   ├── cli.ts                         (+ cli.test.ts)
│   ├── commands/                      run · diff · undo · show · retry (+ .test.ts)
│   ├── orchestrator.ts                (+ orchestrator.test.ts)
│   ├── scanners/
│   │   ├── scanner.ts                 interface + shared run sequence
│   │   ├── scope.ts                   changed-files vs whole-repo
│   │   └── eslint-sonarjs · knip · jscpd · semgrep · osv · gitleaks  (+ .test.ts)
│   ├── findings/
│   │   ├── finding.ts                 type + fingerprint
│   │   ├── store.ts                   reconcile across loops
│   │   └── router.ts                  split by track
│   ├── gate/
│   │   ├── gate.ts                    run checks in order, stop on first reject
│   │   └── checks/                    anti-suppression · anti-regression · typecheck · tests
│   ├── fixing/
│   │   ├── change-set.ts              apply / revert
│   │   ├── session.ts                 interface + claude impl
│   │   └── dispatch.ts                p-queue, group by file
│   ├── git/                           snapshot · repo
│   ├── detect/                        package-manager · typescript · test-runner
│   ├── report/                        builder · schema
│   ├── output/                        events · listr-reporter · summary
│   └── config/                        load · schema
├── test/
│   ├── fixtures/  repos/  scanner-outputs/
│   ├── helpers/   fakeSession · fakeScanner · tmpRepo
│   └── loop.integration.test.ts
├── prompts/fix.md
├── docs/          TEND_SPEC.md · TEND_DECISIONS.md · TEND_IMPLEMENTATION.md
├── package.json · tsconfig.json · tsdown.config.ts · vitest.config.ts
└── README.md · LICENSE
```

---

## Test plan

### 1. `findings/finding.ts` — type + fingerprint
- [ ] **T-001** happy: same `tool|rule|file|line|message` → identical fingerprint
- [ ] **T-002** edge: changing any one component → different fingerprint
- [ ] **T-003** edge: same logical issue from two different tools → different fingerprints
- [ ] **T-004** happy: a raw record normalizes into a `Finding` with all required fields
- [ ] **T-005** edge: optional fields absent (`helpUri`/`flowPath`/`remediation`) → still a valid `Finding`

### 2. `findings/store.ts` — store + reconciliation
- [ ] **T-006** happy: add findings → retrievable by id
- [ ] **T-007** edge: adding same fingerprint twice → one entry (dedupe)
- [ ] **T-008** happy: finding present last loop, absent now → marked `fixed`
- [ ] **T-009** happy: present both loops → stays `pending`, attempts/history carried
- [ ] **T-010** happy: new fingerprint this loop → added `pending`, `firstSeenLoop` set
- [ ] **T-011** happy: failed fix increments `attempts`; budget reports exhausted at N
- [ ] **T-012** happy: query by track / status / file
- [ ] **T-013** edge: empty audit → all previously-known reconcile to `fixed`
- [ ] **T-014** happy: serialize → JSON → deserialize round-trips and is zod-valid

### 3. `findings/router.ts` — split by track
- [ ] **T-015** happy: sonarjs/knip/jscpd/semgrep → `ai-fix`
- [ ] **T-016** happy: osv → `deterministic`
- [ ] **T-017** happy: gitleaks → `report-only`
- [ ] **T-018** edge: unknown tool → skipped with a warning, not fatal

### 4. `scanners/scanner.ts` — interface + shared run sequence
- [ ] **T-019** happy: `isAvailable` true when binary resolves
- [ ] **T-020** edge: `isAvailable` false when binary missing
- [ ] **T-021** happy: run sequence calls availability → args → spawn → parse → normalize in order
- [ ] **T-022** edge: missing binary → scanner skipped (not fatal)
- [ ] **T-023** edge: subprocess exits non-zero but emits parseable findings (e.g. eslint) → still parsed
- [ ] **T-024** edge: subprocess timeout → error result, run continues
- [ ] **T-025** edge: malformed JSON output → captured as error, no crash

### 5. `scanners/<tool>.ts` — parse frozen fixtures → `Finding[]`
- [ ] **T-026** knip: fixture → expected unused files/exports/deps findings
- [ ] **T-027** eslint+sonarjs: fixture → findings with rule, severity, range
- [ ] **T-028** jscpd: fixture → duplication findings with clone locations
- [ ] **T-029** semgrep: fixture → security findings with `flowPath` (source→sink)
- [ ] **T-030** osv: fixture → vuln-dep findings with `remediation` (version bump)
- [ ] **T-031** gitleaks: fixture → secret findings with location
- [ ] **T-032** edge (each tool): empty output → `[]`

### 6. `scanners/scope.ts` — changed-files vs whole-repo
- [ ] **T-033** happy: returns files changed vs `HEAD`
- [ ] **T-034** happy: filters a finding set down to changed files
- [ ] **T-035** happy: `--all` → no filtering
- [ ] **T-036** happy: whole-repo tools scanned wide, findings then filtered to changed
- [ ] **T-037** edge: clean tree → empty changed set → nothing dispatched

### 7. `gate/checks/anti-suppression.ts`
- [ ] **T-038** reject: diff adds `eslint-disable`
- [ ] **T-039** reject: diff adds `@ts-ignore` / `@ts-nocheck`
- [ ] **T-040** reject: diff adds a cast to `any`
- [ ] **T-041** reject: code deleted instead of fixed
- [ ] **T-042** happy: a legitimate fix passes
- [ ] **T-043** edge: cast to `unknown` is allowed (not `any`)
- [ ] **T-044** edge: a pre-existing disable comment left untouched → not flagged (only new ones)

### 8. `gate/checks/anti-regression.ts`
- [ ] **T-045** reject: fix introduces a new finding
- [ ] **T-046** happy: fix strictly reduces findings
- [ ] **T-047** edge: net-neutral (resolve 1, add 1) → reject (no lateral move)

### 9. `gate/checks/typecheck.ts`
- [ ] **T-048** happy: fix that typechecks passes
- [ ] **T-049** reject: fix that breaks `tsc --noEmit`
- [ ] **T-050** edge: no `tsconfig` → check skipped (pass)

### 10. `gate/checks/tests.ts` — baseline · repair window · teeth check
- [ ] **T-051** happy: baseline records which tests are green at start
- [ ] **T-052** happy: fix, related tests stay green, no test touched → pass
- [ ] **T-053** reject: fix turns a previously-green test red, no repair → reject
- [ ] **T-054** happy: repair window — AI edits code, test goes green within N tries → pass
- [ ] **T-055** reject: repair window exhausted, still red → reject
- [ ] **T-056** happy: teeth check — edited test fails on OLD code → pass (has teeth)
- [ ] **T-057** reject: teeth check — edited test passes on OLD code → rubber stamp → reject
- [ ] **T-058** happy: structural test edit (moved import) → allowed
- [ ] **T-059** happy: semantic test edit (changed assertion) passes teeth check but is flagged for review
- [ ] **T-060** edge: no test suite → degrades to pass with a warning
- [ ] **T-061** edge: a pre-existing failing test is ignored (not in baseline)

### 11. `gate/gate.ts` — orchestrate checks
- [ ] **T-062** happy: runs checks in defined order
- [ ] **T-063** happy: all checks pass → keep
- [ ] **T-064** reject: stops on first failing check and returns its `revertReason`

### 12. `fixing/change-set.ts` — apply / revert
- [ ] **T-065** happy: `apply` writes edits to the working tree
- [ ] **T-066** happy: `revert` restores file(s) to pre-change state
- [ ] **T-067** happy: atomic — code + sibling test revert together
- [ ] **T-068** edge: revert after a partial apply → clean restore

### 13. `fixing/session.ts` — interface + claude impl
- [ ] **T-069** happy: fake session returns scripted edits (the test harness)
- [ ] **T-070** happy: claude impl parses stream-json → edits
- [ ] **T-071** edge: session crash/error → failed-attempt result (no throw)
- [ ] **T-072** edge: rate-limit signal surfaced for backoff

### 14. `fixing/dispatch.ts` — p-queue, group by file
- [ ] **T-073** happy: findings grouped by file
- [ ] **T-074** happy: each worker owns disjoint files (incl. sibling test)
- [ ] **T-075** happy: concurrency cap respected
- [ ] **T-076** edge: more files than workers → excess queued
- [ ] **T-077** edge: file with multiple findings → one session handles all of them

### 15. `git/snapshot.ts` — capture / restore (the safety net)
- [ ] **T-078** happy: capture working-tree state (tracked + untracked)
- [ ] **T-079** happy: restore returns working tree to captured state
- [ ] **T-080** happy: diff shows only the tool's edits (snapshot vs now)
- [ ] **T-081** edge: untracked files are included in capture/restore

### 16. `git/repo.ts` — git ops
- [ ] **T-082** edge: not a git repo → error
- [ ] **T-083** happy: list files changed vs `HEAD`
- [ ] **T-084** happy: revert a single file to snapshot

### 17. `detect/` — environment
- [ ] **T-085** happy: detect package manager from lockfile (pnpm/npm/yarn/bun)
- [ ] **T-086** happy: detect TypeScript via `tsconfig`
- [ ] **T-087** happy: detect test runner (vitest/jest) from config + `package.json`
- [ ] **T-088** edge: no test runner detected → none
- [ ] **T-089** edge: no `tsconfig` → JS mode

### 18. `config/` — cosmiconfig + zod
- [ ] **T-090** happy: loads config file via cosmiconfig
- [ ] **T-091** happy: zero-config defaults applied when no file
- [ ] **T-092** edge: invalid config rejected by zod with a clear message
- [ ] **T-093** happy: CLI flags override config (maxLoops, maxSessions, …)

### 19. `report/` — builder + schema
- [ ] **T-094** happy: builder accumulates per-finding outcomes over the run
- [ ] **T-095** happy: built `report.json` validates against the zod schema
- [ ] **T-096** happy: report includes secrets, dep bumps, flagged behavior changes, timings, exit status

### 20. `output/` — events + reporter + summary
- [ ] **T-097** happy: orchestrator emits events; reporter receives them
- [ ] **T-098** edge: silent mode (no listener) → no terminal output, loop still runs
- [ ] **T-099** happy: summary renders counts + per-tool table
- [ ] **T-100** happy: remaining issues grouped by reason, ordered secrets → security → couldn't-fix → review

### 21. `orchestrator.ts` — the loop + termination
- [ ] **T-101** happy: audit → fix → re-audit → converged (0) → stop
- [ ] **T-102** happy: re-audit runs once per loop (after the batch), not per session
- [ ] **T-103** happy: secrets surfaced, excluded from fixes, exit non-zero, code fixes still proceed
- [ ] **T-104** happy: deterministic dep pass runs separately (no AI)
- [ ] **T-105** edge: max-loops cap reached → stop, report remaining
- [ ] **T-106** edge: no-progress (loop resolved nothing) → stop
- [ ] **T-107** edge: per-issue budget exhausted → mark that finding unfixable, continue others
- [ ] **T-108** edge: oscillation (fix A → create B → fix B → create A) → no-progress stop
- [ ] **T-109** edge: zero findings at start → exit clean immediately
- [ ] **T-110** edge: all scanners missing → error exit

### 22. `commands/` + `cli.ts`
- [ ] **T-111** happy: `run` wires audit → fix → report (with fakes)
- [ ] **T-112** happy: `diff` shows only the tool's edits
- [ ] **T-113** happy: `undo` restores the snapshot
- [ ] **T-114** happy: `show <id>` prints finding detail (attempts, flow path)
- [ ] **T-115** happy: `retry <id>` re-attempts with a larger budget
- [ ] **T-116** happy: cli parses args/flags → dispatches the right command
- [ ] **T-117** edge: unknown command → help/error

### 23. Integration — `test/loop.integration.test.ts` (fixture repo + fake session)
- [ ] **T-118** full loop: seeded issues → fixed → report, on a real fixture repo
- [ ] **T-119** a fix that breaks a test is reverted end-to-end
- [ ] **T-120** secret in fixture → surfaced/halted, code fixes still proceed
- [ ] **T-121** `undo` restores the fixture repo exactly to pre-run state

### 24. Path-scoped fixing — `tend run <path...>`
- [x] **T-122** `filesUnder(git, paths)` expands a dir to its files, a single file to itself, includes untracked, and yields `[]` for a no-match path — all repo-cwd-relative
- [x] **T-123** `cli.ts` parses `run <path...>` positionals into `opts.paths`
- [x] **T-124** `buildAudit` scans an injected scope list (`null` = whole repo) instead of re-deriving `changedVsHead`
- [x] **T-125** with a path scope, a finding outside the path is reported but not fixed; one inside is fixed

---

## Definition of done

- All `T-xxx` checked, suite green.
- `tend` runs end-to-end on a real repo (manual smoke test).
- Self-contained: no `@ajiri/*` imports; `tsc`, build (`tsdown`), and tests pass from inside `packages/tend/`.
- `README.md` + `LICENSE` (MIT) present.
