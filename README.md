# tend

> Tend your code now so it never becomes an overgrown mess.

An open-source CLI that audits a JS/TS repo with established scanners, then fixes the
findings with parallel AI sessions in a safe **scan → fix → re-scan** loop. It never
commits — fixes are left as uncommitted edits for you to review.

```bash
npx tend-cli          # snapshot → audit → fix loop → report (changed files)
npx tend-cli --all    # fix the entire backlog, not just changed files
```

## Why

Every team already has scanners. What they don't have is the time to act on 200
findings. tend closes the loop: **deterministic detection → AI fix → deterministic
verification**. Machines find and check; the model only does the edit. The worst case
is "tend changed nothing," never "tend broke your code."

## What it runs

| Category | Tools | Action |
|----------|-------|--------|
| AI fix loop | `eslint`+`sonarjs`, `knip`, `jscpd`, `semgrep` | findings fed to AI sessions |
| Deterministic | `osv-scanner` | dependency version bumps, no AI |
| Report-and-halt | `gitleaks` | secrets surfaced loudly, never AI-touched; exit non-zero |

**`eslint`+`sonarjs`, `knip`, and `jscpd` ship with tend** (bundled deps, resolved from tend's
own install) — they work with zero setup. eslint+sonarjs runs via the ESLint Node API in one of
three modes, picked automatically:

| Your project | tend runs |
|--------------|-----------|
| no eslint config | **tend's config** — eslint recommended + sonarjs recommended (TS/JSX parsed, no tsconfig needed) |
| eslint config, no sonarjs | **your config + sonarjs layered on top** — your rules *and* sonarjs in one pass |
| eslint config with sonarjs | **your config, untouched** |

For `knip` and `jscpd`: tend uses **your project's installed version if you have one** (and that
tool auto-loads your `knip.json` / `.jscpd.json` from the repo root), otherwise it falls back to
tend's bundled copy. So if you already use them, tend runs *your* setup; if not, it just works.

The native tools — `semgrep`, `osv-scanner`, `gitleaks` — can't be npm deps; install those
yourself (`brew install …`). tend skips any missing scanner with a hint and errors only if none
of the six are present.

## Safety

- **In-place edits** on your actual files — no worktrees, no branches.
- A **silent snapshot** (tracked + untracked) is taken first as an invisible restore point.
- Every fix passes a gate — **anti-suppression · anti-regression · `tsc` · tests** — or it's
  reverted atomically (code + its sibling test together).
- Tests are the behavior oracle: a fix may edit a test, but a **teeth check** rejects any
  edit that no longer fails on the old code.

## Commands

| Command | What it does |
|---------|--------------|
| `tend` / `tend run` | snapshot → audit → fix loop → report |
| `tend diff` | show only the tool's edits (your own changes filtered out) |
| `tend undo` | restore the pre-run snapshot exactly |
| `tend show <id>` | full detail on one finding (attempts, flow path, docs) |
| `tend retry <id>` | re-attempt a stubborn finding with a larger budget |

## Config (zero-config by default)

`cosmiconfig` discovery (`.tendrc`, `tend.config.js`, a `tend` key in `package.json`, …):

```jsonc
{
  "maxSessions": 4,
  "maxLoops": 5,
  "perIssueBudget": 3,
  "teethCheck": true,
  "includeTests": false,
  "model": "sonnet",
  "effort": "high"
}
```

CLI flags (`--max-loops`, `--max-sessions`, `--model`, `--effort`, `--all`) override the config
file. `model` is an alias (`sonnet` default, `opus`, `haiku`) or a full model id (e.g.
`claude-opus-4-8`); `effort` is the reasoning effort (`low | medium | high | xhigh | max`,
unset → claude's default). Both are passed straight to `claude -p`.

## Output

A live `listr2` task tree while running, a machine-readable `.tend/report.json`, and a
final summary that groups remaining issues by **why** tend couldn't fix them, ordered by
urgency: secrets → security → couldn't-fix → needs-review.

## License

MIT
