# tend — Design Decisions (the *why*)

Rationale behind every non-obvious choice in [`TEND_SPEC.md`](./TEND_SPEC.md). Written as blog-post raw material: each entry is *the problem → the options → what we chose → why*.

---

## 1. Why a fix loop at all, not just a linter dashboard

Every team already has scanners. What they don't have is the *time* to act on 200 findings. A report that nobody fixes is debt with extra steps. The bet behind tend: the act of *fixing* is now cheap enough (a capable coding model behind `claude -p`) that we can close the loop — scan, fix, prove the fix, repeat — instead of just producing another list. The name **tend** captures the thesis: small upkeep now, applied continuously, is what keeps a codebase from sliding into the unmaintainable mess that no single heroic refactor ever recovers from.

---

## 2. Why not just prompt the LLM to "fix the code" — the central thesis

The obvious version of this tool is one prompt: *"here's my repo, find and fix the problems."* It doesn't work, and the research on why is now decisive. The architecture of tend — **deterministic detection → LLM fix → deterministic verification** — is a direct response to three measured failures of prompt-only repair.

**1. LLMs produce *plausible* fixes, not *correct* ones.** Automated-program-repair research draws a hard line between a **plausible** patch (passes the tests) and a **correct** patch (actually implements the intent). [Patch overfitting — plausible but non-generalizable fixes — is endemic](https://arxiv.org/html/2511.16858v1): the model writes something that looks right and even goes green, but doesn't fix the real problem. In the security domain it's worse — [over half of LLM-generated patches apply a fundamentally incorrect repair strategy](https://arxiv.org/html/2603.10072v1). And studies re-checking "solved" benchmark issues find [many aren't actually solved correctly](https://software-lab.org/publications/icse2026_SWE-bench-correctness.pdf). A prompt-only tool has no way to tell plausible from correct — so it ships the plausible one.

**2. Grounding the model in tool output dramatically raises the hit rate.** Meta's neuro-symbolic repair study measured it directly: a bare ReAct agent solved **28.5%** of issues; the *same model* given **static-analysis + test-execution feedback** hit **42.3%**, and **61.0%** with multiple trials ([Agentic Program Repair at Scale](https://arxiv.org/abs/2507.18755)). The lift comes entirely from feeding the model *deterministic facts* — what the analyzer found, what the tests did — rather than asking it to imagine them. LLMs that reason from tool output are [more trustworthy and easier to verify than ungrounded ones](https://arxiv.org/pdf/2507.06920); ungrounded, they [hallucinate execution traces and "validate" their own buggy code](https://arxiv.org/abs/2604.19825).

**3. Verifying is more reliable than generating — so put determinism on *both* ends.** The generation–verification gap means a model can produce a correct fix but fail to *recognize* it's correct. The fix isn't a bigger model; it's to stop relying on the model for the parts machines do better. So tend brackets the neural step with symbolic ones:

- **Detection is deterministic** — the scanners (sonarjs, knip, semgrep, etc.) report *real, precisely-located* issues. The LLM never has to guess *what's wrong* or *where*; it's handed exact, reproducible findings. This kills a whole class of hallucinated problems.
- **The LLM does only the judgment step** — generating the actual edit, which is what it's genuinely good at.
- **Verification is deterministic** — the gate (re-scan + anti-suppression + `tsc` + tests + the teeth check) catches plausible-but-wrong fixes mechanically, instead of trusting the model's self-assessment.

That's the whole design in one line: **let machines find and check; let the model fix.** Prompt-only collapses all three jobs onto the model, which is exactly the configuration the research shows fails. tend is neuro-symbolic on purpose — deterministic bookends around a neural core.

---

## 3. Why these six tools — and why they barely overlap

We picked tools that are each best-in-class at *one* thing, with almost no redundancy:

| Tool | Catches | Why it's irreplaceable |
|------|---------|------------------------|
| eslint + sonarjs | bugs + code smells | semantic per-file rules: identical branches, duplicated literals, cognitive complexity |
| knip | dead code/exports/deps | the only one that builds the **whole module graph** — sees what no per-file tool can |
| jscpd | duplication | Rabin-Karp clone detection across the corpus |
| gitleaks | secrets | regex + **entropy**, scans git **history**, not just the working tree |
| semgrep | security vulns | **taint analysis** — tracks untrusted data from source → sink |
| osv-scanner | vulnerable deps | matches your lockfile against the OSV.dev database |

The decision rule: a tool earns its place only if removing it creates a blind spot none of the others cover. All six pass that test — two for dead/duplicate code, two for the code you wrote, two for secrets and dependencies.

---

## 4. Why not everything goes into the AI fix loop

The biggest early mistake would be "feed all six tools' findings to the AI." Three of them must **not** be fixed by an AI:

- **Secrets (gitleaks) → never AI-touched.** Deleting a secret from the working tree does *nothing* — it's already in git history, and the only real fix is to **rotate/revoke** the credential, which only a human can do. An AI "fixing" a secret produces a dangerous false sense of safety. So secrets are surfaced loudly and the run exits non-zero, but the AI never goes near them.
- **Vulnerable dependencies (osv-scanner) → deterministic, not AI.** The fix is a version bump, and there's a *correct* answer (osv-scanner v2 ships guided remediation). Letting an AI freehand-edit dependency versions is strictly worse than running the deterministic resolver.
- **Everything else (eslint/sonarjs, knip, jscpd, semgrep) → AI loop.** These need judgment edits, which is exactly what an AI is good at.

Decision: **route by fix-type, not by tool.** Judgment edits to the AI; deterministic fixes to a resolver; dangerous-to-automate findings to a human.

---

## 5. Why we partition work by file

Parallel AI sessions editing the same file will clobber each other — last writer wins, edits lost. Two ways to avoid it: file-level locks, or partition so collisions are impossible. We chose partition: **group findings by file, give each worker a disjoint set of files** (including that file's sibling test). No two sessions ever touch the same file, so there's nothing to lock. As a bonus, the re-audit happens *once per loop* after the whole batch settles — not after every session — which is both cheaper and the only point where "what's left?" is a meaningful question.

---

## 6. Why it's thin glue over existing libraries

Every hard part of an orchestrator already has a battle-tested library, and a tool meant to be trusted with people's code is not the place to hand-roll a concurrency queue or git plumbing. So the engine is deliberately boring: `p-queue` (worker pool), `execa` (subprocess), `simple-git` (every git op), `listr2` (live UI), `zod` (schema), `cosmiconfig` (config), `commander` (CLI). The scanners themselves are **invoked, never reimplemented**. The only code we own is the glue: scanner adapters, the normalizer, the dispatcher, the verification gate, and the loop. Less surface area, fewer ways to corrupt someone's repo.

---

## 7. Why in-place edits + a silent snapshot, not a git worktree

This was the longest debate, because it's the "don't destroy people's code" decision, and tend is meant for strangers to run.

The thing we're protecting (your uncommitted changes) is also the thing we're fixing — you run tend *after* making changes, to clean up the work you just did. Two options:

- **Worktree** (a second checkout in a temp dir; physically separate). Safest in theory — your real files can't be touched. But a fresh worktree starts from your last *commit* and doesn't carry your uncommitted work, so you'd have to copy dirty state over and the result back. That "copy dirty state between checkouts" dance is exactly the git plumbing that goes wrong, and it asks the user to understand worktrees.
- **In-place + silent snapshot** (chosen). Before touching anything, capture the full working-tree state (tracked + untracked) as a git object — invisibly, nothing committed, the editor sees no change. Then fix in place. Because we hold the snapshot, we can always answer *"what did you change?"* (`tend diff` — only the tool's edits, your own changes filtered out) and *"undo it"* (`tend undo` — restore the snapshot exactly).

We chose in-place because it needs **zero git knowledge** from the user, operates natively on the uncommitted work they want fixed, and the safety comes from the snapshot + the per-fix gate rather than from physical isolation. And tend **never commits** — fixes land as uncommitted edits for the dev to review and commit themselves, so we stay out of their git history entirely.

---

## 8. Why re-auditing isn't enough — the AI will cheat the scanners

If the only check is "does the scanner go quiet?", the cheapest way to satisfy it is to **suppress**: add `// eslint-disable`, `@ts-ignore`, `@ts-nocheck`, cast to `any`, or just delete the offending code. The scanner reports "fixed" and nothing was actually fixed. So every fix must pass a **gate** before it's kept: an anti-suppression check (reject disable-comments, any-casts, deletions-instead-of-fixes), a typecheck (`tsc --noEmit`), and the tests. Fail any → revert. The guiding principle: **the worst outcome should be "tend changed nothing," never "tend broke your code."**

---

## 9. The hard one: tests. Why "revert on break" and "let the AI fix it" are both wrong

The instinct is "if a fix breaks a test, revert it." But refactoring *legitimately* breaks tests — extract a function and the test's import path moves. Blanket-revert makes the tool useless for real refactoring.

The opposite instinct is "let the AI fix the test too." But this hits a **measured** failure mode: LLMs write assertions that mirror *what the code does, not what it should do*, and that tendency gets **8–9 percentage points worse when the code contains a bug** ([research on AI test oracles](https://dev.to/rsri/mutation-testing-the-missing-safety-net-for-ai-generated-code-54kn)). So an AI "fixing" a failing test will often just rubber-stamp the broken behavior. That's **oracle corruption** — the test silently stops protecting you.

The resolution came from prior art:

- **Tests are the behavior oracle.** We baseline which tests pass at startup; pre-existing failures are ignored (not our fault). A fix that turns a *previously-green* test red is a behavior change we have to scrutinize.
- **A red test opens a bounded repair window, not an instant revert.** Inside it, the AI diagnoses *why* it's red — wrong code (edit the code) or moved structure (edit the test's imports/mocks) — and retries a few times. Only if it can't get green within the constraints do we revert. ([SWE-agents apply cross-file refactors atomically and revert the whole group on failure](https://arxiv.org/html/2507.18755v1) — we do the same: a fix is the change-set of code + its sibling test, kept or reverted together.)
- **Test edits are classified.** *Structural* edits (imports, mocks, paths following a refactor) are allowed freely. *Semantic* edits (a changed assertion/expected value) are treated as behavior changes — gated hard and flagged in the report for human review.
- **The teeth check — the anti-corruption mechanism.** When the AI edits a test, we run that modified test against the **old, pre-fix code**. It must **fail**. If it passes on *both* old and new code, it asserts nothing — it's a rubber stamp — and we reject the whole change-set. This is the [mutation-testing principle](https://engineering.fb.com/2025/09/30/security/llms-are-the-key-to-mutation-testing-and-better-compliance/): a test that can't tell broken from fixed has no teeth. It's exactly what separates a *legit* behavior-change fix (passes on new, fails on old) from a *defanged* test (passes on both).

The result: refactors that touch tests *do* get fixed, but the oracle can never be silently weakened. For repos with **no tests**, the gate degrades to typecheck + anti-suppression and we say so plainly — honest expectation-setting beats pretending it's safe. (Opt-in golden-master/[characterization snapshots](https://en.wikipedia.org/wiki/Characterization_test) for the no-test case are a planned follow-up.)

---

## 10. Why "max loops" isn't enough to stop

A naive loop ("repeat until 0 issues") never terminates if one issue is genuinely unfixable. So we stop on the *first* of: **converged** (0 issues), **max loops** (hard cap), **no progress** (a whole round fixed nothing — repeating won't help), or **per-issue budget** (a specific fingerprinted finding survived N rounds → mark it unfixable, stop retrying *it*, keep going on the rest). The last two are what make convergence robust: one stubborn finding can't hold the whole run hostage.

---

## 11. Why "detect & defer" instead of framework detection

The previous incarnation hardcoded "Next.js detection." That's a trap — the tool would need a special case per framework forever, and break on the next one. The new rule: **zero hardcoded framework assumptions.** Detect the *generic* facts (package manager from the lockfile, TS vs JS from tsconfig, the test runner from package.json) and **defer to the project's own tool configs**. The payoff is free stack-agnosticism: a Vue project's ESLint config already has the Vue parser; a Next project's already has the React plugins. By using *their* config, tend is automatically correct for whatever stack it's pointed at — React, TanStack, Vue, Svelte, plain Node — without a single framework branch in our code.

---

## 12. Why "scan wide, fix narrow"

It's tempting to scan only changed files for speed. But it's the wrong layer to optimize, and for some tools it's incorrect:

- **knip can't be scoped** — "unused" only means anything against the whole module graph. Scan only changed files and it falsely flags everything as unused.
- **jscpd shouldn't be scoped** — passing only changed files makes it miss the case where your new code duplicates an *unchanged* file, which is the duplication you most want to catch.
- **eslint, semgrep, gitleaks** *can* be diff-aware natively (semgrep has `--baseline-commit`, gitleaks has `--staged`), so we let them.

The key realization: **scanning is cheap (seconds); the AI fix sessions are the expensive part.** So we scan wide enough to be correct, and narrow the *fixes* to changed files by default (`--all` for the backlog). That captures nearly all the efficiency without producing garbage findings. Everything found is still in `report.json` — we fix narrow, but we *report* wide.

---

## 13. Why the name "tend"

The failure mode tend exists to prevent is gradual: skip the cleanup now, and the codebase compounds into something unmaintainable that no one can safely change. The antidote isn't a heroic rewrite — it's continuous, low-effort care. "Tend" is the gardening word for exactly that: you tend a garden so it never becomes overgrown. Act now, ensure a good future.

---

## Appendix — Research that proves the point

**The point:** an LLM told to "fix the code" alone is unreliable and never reliably converges; bracketing it with deterministic detection and deterministic verification is what makes automated fixing work and provably terminate. Only three findings prove that directly — everything else (first-try gaps, industry adoption, framing pieces) is context, not proof, and is deliberately left out.

**1. The LLM's own judgment can't be trusted — fixes are *plausible*, not *correct*.** Patches that pass tests but miss the actual intent are endemic ([arXiv:2511.16858](https://arxiv.org/abs/2511.16858)), and >50% of LLM *security* patches apply a fundamentally wrong strategy ([arXiv:2603.10072](https://arxiv.org/html/2603.10072v1)). This is *why* verification must be deterministic rather than the model grading itself.

**2. Adding the deterministic layer measurably raises success — same model, same task.** Bare agent **28.5%** → with static-analysis + test feedback **42.3%** → with the verify-and-retry loop **61.0%** ([Meta, arXiv:2507.18755](https://arxiv.org/abs/2507.18755)). The lift comes entirely from feeding the model deterministic tool output, not a bigger model.

**3. A deterministic verifier is what makes the loop converge.** Model the LLM+verifier loop as a Markov chain: with per-step error-reduction probability δ it reaches a *Verified* state almost surely, in expected iterations **≤ 4/δ** ([arXiv:2512.02080](https://arxiv.org/pdf/2512.02080)). The formal proof that a stochastic fixer alone never converges, but a deterministic verifier guarantees termination.

**Honesty caveat:** these measure fix-from-issue / code-gen-from-spec, not literally "resolve this jscpd/sonarjs finding" — cite as analogous in mechanism and direction, not identical in task.
