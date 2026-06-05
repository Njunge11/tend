# Changelog

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
