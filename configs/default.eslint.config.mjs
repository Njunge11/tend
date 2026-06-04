// tend's default config, used only when the target project has NO eslint config of its own:
// eslint's recommended rules + eslint-plugin-sonarjs recommended (bugs + code smells), with
// TS/JSX syntax parsing but NO type information (no tsconfig needed → fast).
// Plugins resolve relative to THIS file → from tend's own node_modules.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import sonarjs from "eslint-plugin-sonarjs";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}"],
    languageOptions: {
      parser: tseslint.parser, // syntactic only — no parserOptions.project → no type-checking cost
      parserOptions: { ecmaFeatures: { jsx: true } },
      // Declare the standard runtime environments so `no-undef` doesn't flag platform
      // globals (process, console, fetch, crypto, setTimeout, AbortSignal, …).
      globals: { ...globals.node, ...globals.browser, ...globals.es2024 },
    },
  },
  {
    files: ["**/*.{ts,mts,cts,tsx}"],
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      // On TypeScript, `no-undef` is redundant (the compiler already detects undefined
      // symbols) and—run without type info—false-positives on lib/global types like
      // `AbortSignal`. typescript-eslint's own guidance is to disable it for TS files.
      "no-undef": "off",
      // The core `no-unused-vars` rule reports incorrect errors on TS-only constructs
      // (type-only imports, overload signatures, etc.), so typescript-eslint documents
      // disabling it in favor of its TS-aware replacement. Underscore-prefixed names are
      // the conventional "intentionally unused" signal.
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
  sonarjs.configs.recommended,
];
