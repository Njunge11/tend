// Typed variant of tend's default config: the exact same rule set, plus TypeScript type
// information for TS files via typescript-eslint's project service (each file is matched to
// its nearest tsconfig.json automatically, so monorepos with per-package tsconfigs work).
// Type info is what activates eslint-plugin-sonarjs's ~60 `requiresTypeChecking` rules
// (S2871 sort-without-comparator, S2259 null dereference, S2201 ignored return value, …),
// which silently no-op under the syntactic config.
//
// The scanner selects this file only when the lint group actually has a tsconfig.json;
// files the project service cannot cover fail with a fatal parse message, and the scanner
// re-lints exactly those files under the syntactic default config (see eslint-sonarjs.ts).
import base from "./default.eslint.config.mjs";

export default [
  ...base,
  {
    files: ["**/*.{ts,mts,cts,tsx}"],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
        projectService: true,
      },
    },
  },
];
