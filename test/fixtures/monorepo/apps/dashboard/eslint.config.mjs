// A monorepo package config. Plugins resolve from tend's own node_modules (walking up).
// It does NOT configure sonarjs (so tend should layer sonarjs on top) and it overrides
// the unused-vars rule with the TS-aware version — proving tend used THIS config, not its
// bundled fallback (the fallback never enables `eqeqeq`).
import tseslint from "typescript-eslint";

export default [
  {
    files: ["**/*.{ts,mts,cts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      eqeqeq: "error",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
];
