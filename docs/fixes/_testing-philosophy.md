# Testing philosophy (binding for every fix)

Test **observable behavior and public contracts only**. Do not test implementation details.

**May assert:** returned values · thrown errors · files created/changed · commands executed at an explicit public command-runner boundary · user-facing CLI output · exit codes · persisted config/report data · state via public API.

**Must not assert:** private helper calls · internal function decomposition · internal method names · call order between private helpers · intermediate variables · exact prompt wording (unless the prompt is a documented artifact) · exact ANSI styling (unless testing a renderer contract) · large brittle output snapshots · implementation-specific timing/retries/chunk boundaries (unless documented behavior).

**Refactor-resistance (governing rule):** prefer tests that still pass after a valid refactor. If changing the implementation *without changing user-visible behavior* breaks the test, the test is too coupled — rewrite it.

**Speed-only fixes:** if a fix's only effect is speed (same fix, same correctness), there is nothing user-visible to assert. Test the **decision** (a pure function's return value), not the **delivery** (env var vs flag vs which cache file). At most one integration smoke may touch the dependency boundary, and it asserts the decision arrived — not how.

## TDD loop
red → green → refactor. Write one test, make it pass, refactor, move on. **Do not advance until the current test passes.**
