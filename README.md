# tend

[![CI](https://github.com/Njunge11/tend/actions/workflows/ci.yml/badge.svg)](https://github.com/Njunge11/tend/actions/workflows/ci.yml)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=Njunge11_tend&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=Njunge11_tend)
[![Coverage](https://img.shields.io/sonar/coverage/Njunge11_tend?server=https%3A%2F%2Fsonarcloud.io)](https://sonarcloud.io/summary/new_code?id=Njunge11_tend)
[![Maintainability Rating](https://sonarcloud.io/api/project_badges/measure?project=Njunge11_tend&metric=sqale_rating)](https://sonarcloud.io/summary/new_code?id=Njunge11_tend)
[![npm version](https://img.shields.io/npm/v/tend-cli)](https://www.npmjs.com/package/tend-cli)
![status: alpha](https://img.shields.io/badge/status-alpha-yellow)

*Tend your code now so it never becomes an overgrown mess.*

> [!NOTE]
> **Early days (v0.x).** tend works, but it's young — flags and config may still
> change before 1.0. The fix sessions run on Claude via [Claude Code](https://www.anthropic.com/claude-code)
> for now; support for other models is planned. As with any tool that edits code, run it on a
> committed repo and review the changes. Feedback and issues are very welcome.

An open-source CLI that audits a JS/TS repo with standard scanners, then fixes the findings
with parallel AI sessions in a safe **scan → fix → re-scan** loop. It never commits — fixes
land as uncommitted edits for you to review.

## Quick start

```bash
npx tend-cli                 # changed files vs HEAD (the default)
npx tend-cli src/app lib/    # only findings under these paths
npx tend-cli --all           # the entire backlog, repo-wide
```

Requires **Node ≥ 20**, a git repo, and the [Claude Code](https://www.anthropic.com/claude-code)
CLI (`claude`) installed and signed in — tend drives it to make the fixes. Review the edits with
`tend diff`; undo the whole run with `tend undo`.

## What it does

Scanners find problems; acting on them is the work. tend closes the loop —
**deterministic detection → AI fix → deterministic verification**. The scanners detect what's
wrong and confirm when it's fixed; the model only makes the edit in between. The worst case is
"tend changed nothing," never "tend broke your code."

Six scanners run on one of three tracks:

| Track | Tools | What tend does |
|-------|-------|----------------|
| **AI fix** | `eslint`+`sonarjs`, `knip`, `jscpd`, `semgrep` | each finding fixed by an AI session, then gated — kept only if it passes |
| **Report only** | `osv-scanner` | vulnerable deps surfaced with a suggested version bump (not applied) |
| **Report + fail** | `gitleaks` | secrets reported, never AI-touched; the run exits non-zero |

`eslint`+`sonarjs`, `knip`, and `jscpd` are **bundled and need zero setup**; the native tools
(`semgrep`, `osv-scanner`, `gitleaks`) you install yourself. See [docs/USAGE.md](docs/USAGE.md)
for full scanner behavior, flags, and config.

## Safety

- **In-place edits** to your working tree — no worktrees, no branches, no commits.
- A **silent snapshot** (tracked + untracked) is taken before any edit, so `tend undo` restores
  the pre-run state exactly.
- Every fix must pass a gate — **anti-suppression · anti-regression · `tsc` · tests** — or it's
  reverted atomically (code + its sibling test together).
- Tests are the behavior oracle: a fix may edit a test, but a **teeth check** rejects any edit
  that no longer fails on the old code.

## Configuration

Zero-config by default. Drop a `.tendrc` (or a `tend` key in `package.json`) to tune it:

```jsonc
{
  "maxSessions": 4,
  "maxLoops": 5,
  "model": "sonnet",
  "effort": "high"
}
```

Full flags and config reference: **[docs/USAGE.md](docs/USAGE.md)**.

## Output

While it runs, a live task tree; when it finishes, a summary (fixed / couldn't-fix / left /
secrets, elapsed time, estimated AI cost & tokens) and a machine-readable `.tend/report.json`.
Pass `--plain` for line-per-event output in CI.

## Status & contributing

tend is **pre-1.0 (v0.x)** — interfaces may change between releases, so pin a version if you
need stability. Bug reports, ideas, and PRs are very welcome via
[GitHub issues](../../issues).

## License

[MIT](LICENSE)
