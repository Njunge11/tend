# Fix 2 — Live progress during AI edit

**Status:** clear · **Read first:** [`_testing-philosophy.md`](./_testing-philosophy.md)

## Problem (observed)
During the long AI-edit step the output prints `progress <file>: AI edit` once, then goes silent for minutes. tend already launches the session with `--output-format stream-json --verbose`, so Claude streams activity the whole time — but the spawn buffers the whole stream and only reads it after the session ends (`src/bin.ts` session spawn awaits `execa(...)` then reads stdout). The live events are paid for and thrown away.

## Behavior
While a session runs, tend surfaces ongoing progress derived from the model's event stream — more than a single static stage — without crashing on malformed/partial streams.

## Boundary (what tests may assert)
Emitted events (via `EventBus`) / CLI output. **Not** exact wording, ANSI, counts tied to chunking, or chunk boundaries.

## Test cases
- [x] stream with N activity events → more than one progress update emitted during the run
- [x] stream with zero activity events → run still completes; start + end stages emitted
- [x] malformed/garbage stream line → does not throw; final outcome unchanged
- [x] truncated stream (closes mid-event) → no crash; final outcome still computed from disk
- [x] plain/non-interactive mode → progress written line-by-line (no ANSI required)

## Likely touch points
`src/bin.ts` (session spawn — consume stdout incrementally instead of buffering), `src/session/claude.ts`, `src/output/events.ts` + reporters. Keep the disk-is-source-of-truth outcome logic unchanged.
