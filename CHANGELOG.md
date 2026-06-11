# Changelog

## [0.14.1](https://github.com/Njunge11/tend/compare/tend-cli-v0.14.0...tend-cli-v0.14.1) (2026-06-11)


### Bug Fixes

* apply tend's own type-aware scan fixes across src ([e411b65](https://github.com/Njunge11/tend/commit/e411b65cc56d0861b2aa734503358451dbe535c2))
* **gate:** allow delete-only diffs for deletion-is-the-fix rules + apply tend's own type-aware scan fixes ([21a485e](https://github.com/Njunge11/tend/commit/21a485ed12c76d7eaad59c204cb701d2b9df4ac4))
* **gate:** allow delete-only diffs for rules whose canonical fix is deletion ([e2da04f](https://github.com/Njunge11/tend/commit/e2da04fb0ab73580c5dd194a3ac911b1d12c2142))

## [0.14.0](https://github.com/Njunge11/tend/compare/tend-cli-v0.13.4...tend-cli-v0.14.0) (2026-06-10)


### Features

* **scanner:** type-aware eslint linting when the project has a tsconfig ([a20c329](https://github.com/Njunge11/tend/commit/a20c329c7d980a0407b3cbf87ae2ce4168574b06))
* **scanner:** type-aware eslint linting when the project has a tsconfig ([b5369a4](https://github.com/Njunge11/tend/commit/b5369a4a042a787b97a4f634fd65b4cc4cf34876))

## [0.13.4](https://github.com/Njunge11/tend/compare/tend-cli-v0.13.3...tend-cli-v0.13.4) (2026-06-10)


### Bug Fixes

* serialize git worktree add/remove on the main repo ([fee2e92](https://github.com/Njunge11/tend/commit/fee2e92a8d4aa21bf38605bb0fb70d8a56c95871))

## [0.13.3](https://github.com/Njunge11/tend/compare/tend-cli-v0.13.2...tend-cli-v0.13.3) (2026-06-10)


### Bug Fixes

* **ci:** raise Sonar bridge heap to 12 GB and log heap evolution ([bdebf4f](https://github.com/Njunge11/tend/commit/bdebf4f2875e55e54059aa8f56e430c023e6be64))
* **ci:** raise Sonar bridge heap to 12 GB and log heap evolution ([5998896](https://github.com/Njunge11/tend/commit/599889621738b2634445621624d7b6ceef586b1b))

## [0.13.2](https://github.com/Njunge11/tend/compare/tend-cli-v0.13.1...tend-cli-v0.13.2) (2026-06-10)


### Bug Fixes

* **ci:** give the Sonar JS/TS bridge enough heap to finish analysis ([096e998](https://github.com/Njunge11/tend/commit/096e9987c2f9c4445f9bb97f99c9c761111637be))
* **ci:** give the Sonar JS/TS bridge enough heap to finish analysis ([183a139](https://github.com/Njunge11/tend/commit/183a1394164b15699e2f557e5311e99b1f8c9d4b))

## [0.13.1](https://github.com/Njunge11/tend/compare/tend-cli-v0.13.0...tend-cli-v0.13.1) (2026-06-10)


### Bug Fixes

* require the gate rescan to confirm target findings are resolved ([bee4d02](https://github.com/Njunge11/tend/commit/bee4d02ed813f5d4f4fa04b4c9113ee4fab0341e))
* require the gate rescan to confirm target findings are resolved ([83a8db0](https://github.com/Njunge11/tend/commit/83a8db0c3e71b49c1cf5c2e6544266319801a087))

## [0.13.0](https://github.com/Njunge11/tend/compare/tend-cli-v0.12.1...tend-cli-v0.13.0) (2026-06-10)


### Features

* preflight model access before running fix passes ([f4dac49](https://github.com/Njunge11/tend/commit/f4dac49763815af4f2465709e5fd432041b8a378))
* preflight model access before running fix passes ([4602145](https://github.com/Njunge11/tend/commit/4602145db2d9dab9560a8a4f1383e0826dcb3a8a))

## [0.12.1](https://github.com/Njunge11/tend/compare/tend-cli-v0.12.0...tend-cli-v0.12.1) (2026-06-10)


### Bug Fixes

* stop reverting worker patches as unowned when node_modules is untracked ([b12f410](https://github.com/Njunge11/tend/commit/b12f4108806483a325ce1cfbdc802ae6bb013adc))
* stop reverting worker patches as unowned when node_modules is untracked ([864edba](https://github.com/Njunge11/tend/commit/864edbac979b6f2cb9cf6076829bdcbcaaee5c2e))

## [0.12.0](https://github.com/Njunge11/tend/compare/tend-cli-v0.11.0...tend-cli-v0.12.0) (2026-06-10)


### Features

* **models:** route cognitive-complexity fixes to the capable model ([1c18784](https://github.com/Njunge11/tend/commit/1c1878480d537d07052c51e62c2dd6f44d6f85b8))


### Bug Fixes

* audit accounting, fingerprint drift, termination reporting + opus routing for complexity ([5f2928c](https://github.com/Njunge11/tend/commit/5f2928c710719c37c984d398cc8456194faf8d4a))
* **audit:** exclude unsupported-strategy findings from the eligible population ([4cd9272](https://github.com/Njunge11/tend/commit/4cd92728d49ae0b8c2d521e661f1f4e4d2810651))
* **report:** persist and surface the loop termination reason ([c0d581b](https://github.com/Njunge11/tend/commit/c0d581b02f830bd448bfaa7e9d4e62a67d99550b))
* **store:** re-match line-drifted findings in reconcile instead of phantom-fixing them ([2adb216](https://github.com/Njunge11/tend/commit/2adb216f38ac11f1a324f881ec1d4ae192bfb7ef))

## [0.11.0](https://github.com/Njunge11/tend/compare/tend-cli-v0.10.4...tend-cli-v0.11.0) (2026-06-10)


### Features

* **scanner:** close the Sonar way gap with borrowed ESLint rules in the default config ([8443ff8](https://github.com/Njunge11/tend/commit/8443ff8bc2e49d7e47cb08d81338aaa6b92256ce))

## [0.10.4](https://github.com/Njunge11/tend/compare/tend-cli-v0.10.3...tend-cli-v0.10.4) (2026-06-10)


### Bug Fixes

* **output:** explain the in-scope vs eligible denominator switch and make tables sum ([0f94901](https://github.com/Njunge11/tend/commit/0f9490199493b7807baa6f0a01fb1e87477b88a5))
* **output:** explain the in-scope vs eligible denominator switch and make tables sum ([d7e54d9](https://github.com/Njunge11/tend/commit/d7e54d9116dbe8773ac347a74636a0c382450ac1))

## [0.10.3](https://github.com/Njunge11/tend/compare/tend-cli-v0.10.2...tend-cli-v0.10.3) (2026-06-10)


### Bug Fixes

* **cli:** validate --max-loops/--max-sessions as positive integers ([eabc8b0](https://github.com/Njunge11/tend/commit/eabc8b027113e8483dd6d680be7e9257a4762afb))
* **eslint:** ignore generated dirs in the bundled default config ([304ce9d](https://github.com/Njunge11/tend/commit/304ce9dffc2b3af7656efe470f32382e86740817))
* **gate:** fail closed when the test runner's JSON report is missing or unparseable ([1a2a9c2](https://github.com/Njunge11/tend/commit/1a2a9c2c3e63cf3cf968a41ac94007f7f9bffe9b))
* harden CLI validation, cancellation, scope globs, and gate robustness ([f10637b](https://github.com/Njunge11/tend/commit/f10637b6e40e255893f45244ab03d28a6ac8074b))
* **report:** merge scanner statuses across loops instead of replacing them ([9896e98](https://github.com/Njunge11/tend/commit/9896e987a6f3e1aaade34305fc6d2247aca21428))
* **run:** exit cleanly on a clean tree instead of scanning the whole repo ([5863f03](https://github.com/Njunge11/tend/commit/5863f031bdfb3200bad244a31d830d0fed259572))
* **run:** propagate Ctrl-C so a cancelled run stops instead of draining the backlog ([81091ea](https://github.com/Njunge11/tend/commit/81091ea5c690510182c1c1aa62138a9049b1e350))
* **scope:** support brace alternation and character classes in fix.include/exclude globs ([f51e040](https://github.com/Njunge11/tend/commit/f51e040e51c27c2e9d07c1f28fc7ad4fc9327746))

## [0.10.2](https://github.com/Njunge11/tend/compare/tend-cli-v0.10.1...tend-cli-v0.10.2) (2026-06-09)


### Bug Fixes

* **fixing:** stop report-only findings leaking into AI-fix work units ([41a55cf](https://github.com/Njunge11/tend/commit/41a55cfce5816d95ccec66a5307ce9543da0e56b))
* **fixing:** stop report-only findings leaking into AI-fix work units ([442a17c](https://github.com/Njunge11/tend/commit/442a17cb5afa9d46e969388e19042a1f050d0747))

## [0.10.1](https://github.com/Njunge11/tend/compare/tend-cli-v0.10.0...tend-cli-v0.10.1) (2026-06-09)


### Bug Fixes

* **fixing:** make tsc cache slug provably linear (SonarQube S5852) ([caacc8b](https://github.com/Njunge11/tend/commit/caacc8b8808521f9b2ba3e1cd4e7614a1279fb20))

## [0.10.0](https://github.com/Njunge11/tend/compare/tend-cli-v0.9.6...tend-cli-v0.10.0) (2026-06-09)


### Features

* **fixing:** route duplication fixes to a more capable model ([63241ac](https://github.com/Njunge11/tend/commit/63241ac863ca2f77f6cbd4396d42225058151323))
* **reporter:** count findings with a stable denominator and show the per-job model ([2291d31](https://github.com/Njunge11/tend/commit/2291d3156629b3edb5ea26f10c858609c59621b7))
* **reporter:** count findings with a stable denominator and show the per-job model ([43a5b21](https://github.com/Njunge11/tend/commit/43a5b21d038384d66b5f60d55e67b470bb706fcb))

## [0.9.6](https://github.com/Njunge11/tend/compare/tend-cli-v0.9.5...tend-cli-v0.9.6) (2026-06-09)


### Bug Fixes

* **bin:** SIGKILL timed-out AI sessions so the session cap holds under load ([4d62e4f](https://github.com/Njunge11/tend/commit/4d62e4fb1a33915a532c9bd9bc0319393d7c5035))
* **fixing:** advance the sandbox base so sequential same-file fixes don't patch-conflict ([43945e5](https://github.com/Njunge11/tend/commit/43945e564f6dc2c6e9f16ecdd6450bae4459c38a))
* make tend converge on dense files (advancing sandbox base + SIGKILL session timeout) ([0e6cc06](https://github.com/Njunge11/tend/commit/0e6cc06dd9a1f34fed11717a7cf3591265713d9e))

## [0.9.5](https://github.com/Njunge11/tend/compare/tend-cli-v0.9.4...tend-cli-v0.9.5) (2026-06-09)


### Bug Fixes

* bound fix sessions to sequential batches and de-export over deleting ([fc15384](https://github.com/Njunge11/tend/commit/fc153847609ac2d933ef8bb9af469ea90625d1e4))
* **fixing:** bound fix sessions to sequential batches and de-export over deleting ([1fb180b](https://github.com/Njunge11/tend/commit/1fb180b4c97fd1b588ec6fc1b020bdddd206d81e))

## [0.9.4](https://github.com/Njunge11/tend/compare/tend-cli-v0.9.3...tend-cli-v0.9.4) (2026-06-09)


### Bug Fixes

* **fixing:** stop test-duplicate collateral and gate-failure retry thrash ([2c1bcac](https://github.com/Njunge11/tend/commit/2c1bcac1b9e16498d3537ee59a934291b949f4d9))

## [0.9.3](https://github.com/Njunge11/tend/compare/tend-cli-v0.9.2...tend-cli-v0.9.3) (2026-06-08)


### Bug Fixes

* **fixing:** report-only for ALL test-file duplicates, incl same-file ([cc0f863](https://github.com/Njunge11/tend/commit/cc0f863a64934e29e7e03c9a9139afd59bfb7437))

## [0.9.2](https://github.com/Njunge11/tend/compare/tend-cli-v0.9.1...tend-cli-v0.9.2) (2026-06-08)


### Bug Fixes

* **bin:** align AI-session timeout so the enforced cap matches the intent ([5d1384b](https://github.com/Njunge11/tend/commit/5d1384b1682de09949e97a36b3ae5007ec10780a))

## [0.9.1](https://github.com/Njunge11/tend/compare/tend-cli-v0.9.0...tend-cli-v0.9.1) (2026-06-08)


### Bug Fixes

* cancelSignal bug, performance tuning, fingerprint stability, and output improvements ([ecab94a](https://github.com/Njunge11/tend/commit/ecab94aadef1dabadf98e1a433b26aadc3282493))
* **fixing:** apply patches with a temp-index 3-way merge to survive dirty trees ([7ab5caa](https://github.com/Njunge11/tend/commit/7ab5caafc54136f62750e41cf2f539362eb2dfc1))
* **fixing:** treat any test-involving cross-file duplicate as report-only ([d78702c](https://github.com/Njunge11/tend/commit/d78702c4b5c7762d472f6e12b944400e76fef14b))
* **gate:** baseline pre-existing findings so anti-regression stops reverting good fixes ([15ffb72](https://github.com/Njunge11/tend/commit/15ffb729c762b31f82dfb9fb07e2af796e5ef260))
* improve jscpd duplicate handling and fix worktree patch conflict ([508f373](https://github.com/Njunge11/tend/commit/508f3734ef7616ffb9478a16a275429d46fb25d5))

## [0.9.0](https://github.com/Njunge11/tend/compare/tend-cli-v0.8.0...tend-cli-v0.9.0) (2026-06-08)


### Features

* **fixing:** live progress, worktree dep reuse, incremental typecheck, prompt file context, and clean teardown ([e23ab80](https://github.com/Njunge11/tend/commit/e23ab807b32a3b127fad696ca8ba1aab266f6d87))

## [0.8.0](https://github.com/Njunge11/tend/compare/tend-cli-v0.7.0...tend-cli-v0.8.0) (2026-06-08)


### Features

* **fixing:** apply per-finding extended-thinking budget ([94c5bad](https://github.com/Njunge11/tend/commit/94c5bad794732859756450265ca9a8d6c14c8488))

## [0.7.0](https://github.com/Njunge11/tend/compare/tend-cli-v0.6.1...tend-cli-v0.7.0) (2026-06-07)


### Features

* **fixing:** run fixes in isolated worker sandboxes with a final integration pass ([3451c5d](https://github.com/Njunge11/tend/commit/3451c5de382df335ffdf684d1355951c42ad8267))


### Bug Fixes

* **output:** show real scanner and repair progress ([0631369](https://github.com/Njunge11/tend/commit/0631369f32e2ad98d47eeb3c17257257a97c3fd4))

## [0.6.1](https://github.com/Njunge11/tend/compare/tend-cli-v0.6.0...tend-cli-v0.6.1) (2026-06-05)


### Bug Fixes

* **build:** externalize runtime TypeScript dependency ([7f09d86](https://github.com/Njunge11/tend/commit/7f09d86aed372a93a2fadc504006c8f853253fca))

## [0.6.0](https://github.com/Njunge11/tend/compare/tend-cli-v0.5.0...tend-cli-v0.6.0) (2026-06-05)


### Features

* **fixing:** add repair strategy planner ([fe0ed48](https://github.com/Njunge11/tend/commit/fe0ed481cc69d4bf1772ccfd93e861d53fa6f03d))
* **fixing:** gate strategy-based repair units ([f101992](https://github.com/Njunge11/tend/commit/f1019928cc964e468ec58bcf5fb68000106db84a))
* **fixing:** resolve generated artifacts to source repairs ([18977ab](https://github.com/Njunge11/tend/commit/18977abcbc73efc046f73bc3a912332a6e9bd699))
* **fixing:** run deterministic fixers before AI ([04e8e0b](https://github.com/Njunge11/tend/commit/04e8e0bf649dab5e425935aca7c91bb6c3abb878))
* **jscpd:** repair cross-file duplicates with multi-file units ([460c8d4](https://github.com/Njunge11/tend/commit/460c8d41eaad46e2c6c43e32138307df63cdd71e))
* **prompts:** add strategy-specific repair prompts ([964dcec](https://github.com/Njunge11/tend/commit/964dcecceaf71376e3f9d8e4751374961f4d0058))


### Bug Fixes

* **deps:** keep bundled jscpd and update lockfile ([28d217e](https://github.com/Njunge11/tend/commit/28d217e1aadc5c25a9370f96d8de5a9d7b927667))
* **report:** render truthful failure reasons ([b243af6](https://github.com/Njunge11/tend/commit/b243af6a1b80d6b2633025e5e06b8a5885ab5331))
* **scope:** split report scope from fix scope ([f764cff](https://github.com/Njunge11/tend/commit/f764cff650ce4e82495c3d02ad90e2ad45a19589))
* **session:** classify timeouts and retry adaptively ([91619af](https://github.com/Njunge11/tend/commit/91619af26f93affe16bfc890b293f142be4d32f8))

## [0.5.0](https://github.com/Njunge11/tend/compare/tend-cli-v0.4.1...tend-cli-v0.5.0) (2026-06-05)


### Features

* **gate:** allow code deletion when a ([2f499d2](https://github.com/Njunge11/tend/commit/2f499d2faf32f73045f9f59048bcc65ef4be2763))


### Bug Fixes

* **scanners:** stop sonarjs crashing on --all whole-repo scans ([064c8d3](https://github.com/Njunge11/tend/commit/064c8d3178cafbd920ca7f7a78fad6c559d33315))

## [0.4.1](https://github.com/Njunge11/tend/compare/tend-cli-v0.4.0...tend-cli-v0.4.1) (2026-06-04)


### Bug Fixes

* **git:** strip EDITOR/VISUAL and route git through the hardened env ([6ab2b43](https://github.com/Njunge11/tend/commit/6ab2b43601a3f0dea4c2adf477560f3c5b3ebdbc))

## [0.4.0](https://github.com/Njunge11/tend/compare/tend-cli-v0.3.0...tend-cli-v0.4.0) (2026-06-04)


### Features

* **cli:** default to the run command for bare paths and options ([9e6d502](https://github.com/Njunge11/tend/commit/9e6d502d17a34f4b76971006cb3f1bd417550b14))

## [0.3.0](https://github.com/Njunge11/tend/compare/tend-cli-v0.2.1...tend-cli-v0.3.0) (2026-06-04)


### Features

* **fix:** externalize prompt template and support multi-file fix scope ([bc1cca6](https://github.com/Njunge11/tend/commit/bc1cca60315ace16d40a7c510d3379acff748883))

## [0.2.1](https://github.com/Njunge11/tend/compare/tend-cli-v0.2.0...tend-cli-v0.2.1) (2026-06-04)


### Bug Fixes

* add repository metadata required for npm provenance ([23a350f](https://github.com/Njunge11/tend/commit/23a350fc905450116b98164ff7dda554aca55edb))
* add repository metadata required for npm provenance ([c015ae2](https://github.com/Njunge11/tend/commit/c015ae260d3bbde89601372420b36cce38a441c3))

## [0.2.0](https://github.com/Njunge11/tend/compare/tend-cli-v0.1.2...tend-cli-v0.2.0) (2026-06-04)


### Features

* **tend:** add path-scope detection and extend pipeline coverage ([2029a36](https://github.com/Njunge11/tend/commit/2029a3675c843d6a1c4adcf3a25d7bff341291f4))
* **whatsapp:** add WhatsApp signup flow with OTP verification ([04d7aeb](https://github.com/Njunge11/tend/commit/04d7aebd64f9b4f934ba3b70ea4ed99dce28e3bd))
