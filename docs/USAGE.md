# tend — usage & configuration

Full reference for flags, config, scanner behavior, and output. For the overview, see the
[README](../README.md).

## Commands

Invocation depends on where tend is running:

| Context | Use |
|---------|-----|
| Installed or global command | `tend` |
| Registry one-off | `npx tend-cli@latest` |
| Local contributor run from this repo | `pnpm cli` |

The npm package name is `tend-cli`, but the installed executable is intentionally `tend`; npm
packages and executable names do not need to match. From inside this repository, avoid
`npx tend-cli` because npm can resolve the local package without creating a local `.bin/tend`
shim. Use the repo-local script instead:

```bash
pnpm cli -- src/scanners
```

| Command | What it does |
|---------|--------------|
| `tend [paths...]` / `tend run [paths...]` | snapshot → audit → fix loop → report (no args = changed files) |
| `tend diff` | show only the tool's edits (your own changes filtered out) |
| `tend undo` | restore the pre-run snapshot exactly |
| `tend show <id>` | full detail on one finding (attempts, flow path, docs) |
| `tend retry <id>` | re-attempt a stubborn finding with a larger budget |

## Scope

The root command and explicit `run` command resolve which findings to fix from their arguments:

- **no args** — findings in files changed vs `HEAD` (the default).
- **`[paths...]`** — only findings under the given files/dirs, e.g. `tend src/scanners`,
  `tend run src/scanners`, or `npx tend-cli@latest src/scanners`.
- **`--all`** — the entire repo backlog.

Test files are excluded as fix targets by default; pass `--include-tests` to opt in. A test
file always stays editable as the sibling of the code file it covers.

## Flags

All flags apply to root-level runs and `tend run`:

| Flag | Effect |
|------|--------|
| `--all` | fix the whole repo backlog, not just changed files |
| `--max-loops <n>` | cap on fix loops (default `5`) |
| `--max-sessions <n>` | concurrent AI sessions (default `4`) |
| `--model <model>` | full model id for fixes (default `claude-sonnet-4-6`) |
| `--effort <level>` | reasoning effort: `low \| medium \| high \| xhigh \| max` |
| `--include-tests` | also fix findings in test files (excluded by default) |
| `--plain` | one-line-per-event output for pipes/CI (no color, no spinners) |
| `--no-color` | disable color |
| `--verbose` | full per-tool / per-finding breakdown in the summary |

## Configuration

Zero-config by default. `cosmiconfig` discovers `.tendrc`, `tend.config.js`, a `tend` key in
`package.json`, and the other usual locations:

```jsonc
{
  "maxSessions": 4,     // concurrent AI sessions
  "maxLoops": 5,        // cap on fix loops
  "perIssueBudget": 3,  // fix attempts per finding before it's marked unfixable
  "teethCheck": true,   // reject test edits that pass on the old code
  "includeTests": false,
  "model": "claude-sonnet-4-6",
  "duplicationModel": "claude-opus-4-8", // optional; capable model for jscpd dedup fixes
  "complexityModel": "claude-opus-4-8",  // optional; capable model for cognitive-complexity refactors
  "effort": "high"
}
```

CLI flags override the config file. `model` is a full model id (default `claude-sonnet-4-6`);
`effort` is the reasoning effort (`low | medium | high | xhigh | max`, unset → claude's default).
Both are passed straight to `claude -p`, so the model named in config, output, and the report is
exactly the model that ran.

Duplication (jscpd) fixes and cognitive-complexity refactors need more reasoning than localized
single-file edits, so a work unit containing any duplication or `sonarjs/cognitive-complexity`
finding is fixed with a more capable model — `claude-opus-4-8` by default. Override per kind with
`duplicationModel` / `complexityModel` (a full model id); everything else stays on `model`. One
such finding lifts its whole unit, since a unit's findings share a single session.

## Scanners

Six scanners run on one of three tracks:

| Track | Tools | What tend does with the findings |
|-------|-------|----------------------------------|
| **AI fix** | `eslint`+`sonarjs`, `knip`, `jscpd`, `semgrep` | each finding handed to an AI session, then gated — kept only if it passes |
| **Report only** | `osv-scanner` | vulnerable deps surfaced with a suggested version bump — reported, not applied |
| **Report + fail** | `gitleaks` | secrets reported, never AI-touched; the run exits non-zero |

Cross-file `jscpd` clones are reported only (a multi-file refactor tend doesn't attempt yet);
single-file duplication is fixed on the AI track.

### Bundled vs. native

`eslint`+`sonarjs`, `knip`, and `jscpd` **ship with tend** (bundled deps, resolved from tend's
own install) and work with zero setup. The native tools — `semgrep`, `osv-scanner`, `gitleaks` —
can't be npm deps; install those yourself (`brew install …`). tend skips any missing native
scanner with a hint; the three bundled tools always run, so a run never aborts for lack of
scanners.

For `knip` and `jscpd`, tend uses **your project's installed version if you have one** (which
auto-loads your `knip.json` / `.jscpd.json` from the repo root), otherwise it falls back to tend's
bundled copy. If you already use them, tend runs *your* setup; if not, it just works.

### eslint + sonarjs modes

eslint+sonarjs runs via the ESLint Node API in one of three modes, picked automatically per file:

| Your project | tend runs |
|--------------|-----------|
| no eslint config | **tend's config** — eslint recommended + sonarjs recommended (TS/JSX parsed, no tsconfig needed) |
| eslint config, no sonarjs | **your config + sonarjs layered on top** — your rules *and* sonarjs in one pass |
| eslint config with sonarjs | **your config, untouched** |

## Output

While running, a live `listr2` task tree shows each loop, file, and fix outcome. When it
finishes you get a summary with:

- a **run summary** — fixed / couldn't-fix / skipped-tests / left / secrets, elapsed time, and
  estimated AI cost, sessions, and token usage;
- a **per-scanner breakdown** — which scanners ran, were skipped, or failed, with counts;
- **couldn't-fix** and **secrets** tables, each with the `tend retry <id>` / action to take next;
- a **next-commands** hint (`tend diff` · `git add -p` · `tend undo`).

Use `--plain` for line-per-event output in CI, or `--verbose` for the full per-finding listing.
Every run also writes a machine-readable `.tend/report.json` (findings, outcomes, scanner
statuses, suggested dep bumps, and AI usage).
