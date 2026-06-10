// Single source of truth for directory names treated as generated output. Used by
// src/scanners/scope-policy.ts (excludes findings in these dirs from fix scope) and by
// configs/default.eslint.config.mjs (skips them entirely on default-mode scans).
// Plain data, no dependencies: this file is imported both at runtime by ESLint (raw,
// shipped in configs/) and at build time by tsdown (inlined into dist/).
export const GENERATED_SEGMENTS = [
  ".tend",
  ".turbo",
  ".next",
  ".vercel",
  "coverage",
  "dist",
  "build",
  "out",
  "generated",
  "__generated__",
];
