// tend's default config, used only when the target project has NO eslint config of its own:
// eslint's recommended rules + eslint-plugin-sonarjs recommended (bugs + code smells) + the
// "Sonar way borrowed rules" blocks below, with TS/JSX syntax parsing but NO type information
// (no tsconfig needed → fast). When the target project HAS a tsconfig, the scanner selects
// default.eslint.typed.config.mjs instead, which layers type information on top of this
// config so sonarjs's type-aware rules fire too.
// Plugins resolve relative to THIS file → from tend's own node_modules.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import sonarjs from "eslint-plugin-sonarjs";
import importPlugin from "eslint-plugin-import";
import globals from "globals";
import { GENERATED_SEGMENTS } from "./generated-segments.mjs";

// ─── Sonar way borrowed rules ────────────────────────────────────────────────────────────
// SonarQube/SonarCloud's default "Sonar way" JS/TS profile is the sonarjs rules PLUS ~210
// rules it borrows from ESLint core and third-party plugins — which eslint-plugin-sonarjs
// deliberately does NOT ship, so a tend run that relies on sonarjs alone passes code that
// SonarCloud then flags. The blocks below close that gap for every borrowed rule that is
// (a) active in Sonar way, (b) runs without type information, and (c) isn't framework- or
// style-specific (react/jsx-a11y/@angular-eslint and eslint-plugin-unicorn are omitted).
//
// Source of truth (regenerate on eslint-plugin-sonarjs upgrades): the active keys in
// Sonar_way_profile.json intersected with the borrowed-rule mapping table, both in the
// SonarJS repo — sonar-plugin/javascript-checks/.../Sonar_way_profile.json and
// packages/analysis/src/jsts/rules/README.md. Current as of eslint-plugin-sonarjs 3.0.7.
// Each rule is annotated with its Sonar key; "approx" marks rules Sonar runs in a modified
// form, where the original enabled here is close but not identical.

// Borrowed ESLint-core rules (all file types). Some overlap js.configs.recommended; they are
// listed exhaustively anyway so the Sonar-way set is complete in one place and immune to
// upstream changes in what "recommended" includes.
const SONAR_WAY_CORE_RULES = {
  "constructor-super": "error", // S3854 approx
  "default-param-last": "error", // S1788 approx (TS files use the @typescript-eslint version)
  "getter-return": "error", // S4275 approx
  "max-params": ["error", { max: 7 }], // S107 approx — Sonar's default threshold is 7
  "new-cap": ["error", { capIsNew: false }], // S2430 approx — Sonar only checks `new lowercase()`
  "no-caller": "error", // S2685
  "no-case-declarations": "error", // S6836
  "no-constant-binary-expression": "error", // S6638
  "no-constructor-return": "error", // S6635
  "no-dupe-args": "error", // S1536
  "no-dupe-keys": "error", // S1534 approx
  "no-empty": "error", // S108
  "no-empty-function": "error", // S1186 approx (TS files use the @typescript-eslint version)
  "no-empty-pattern": "error", // S3799 approx
  "no-extend-native": "error", // S6643 approx
  "no-extra-bind": "error", // S6637
  "no-extra-boolean-cast": "error", // S6509
  "no-import-assign": "error", // S6522
  "no-lone-blocks": "error", // S1199
  "no-lonely-if": "error", // S6660 approx
  "no-loss-of-precision": "error", // S6534
  "no-multi-str": "error", // S1516
  "no-new-native-nonconstructor": "error", // S3834
  "no-octal": "error", // S1314
  "no-octal-escape": "error", // S6657
  "no-proto": "error", // S6654
  "no-redeclare": "error", // S2814 approx (TS files use the @typescript-eslint version)
  "no-self-assign": "error", // S1656
  "no-self-compare": "error", // S6679 approx
  "no-sequences": "error", // S878
  "no-setter-return": "error", // S2432
  "no-sparse-arrays": "error", // S4140
  "no-throw-literal": "error", // S3696 approx
  "no-undef-init": "error", // S6645
  "no-unmodified-loop-condition": "error", // S2189 approx
  "no-unneeded-ternary": "error", // S6644
  "no-unreachable": "error", // S1763 approx
  "no-unreachable-loop": "error", // S1751
  "no-unsafe-finally": "error", // S1143 approx
  "no-unsafe-negation": "error", // S3812
  "no-unsafe-optional-chaining": "error", // S6523
  "no-unused-expressions": "error", // S905 approx (TS files use the @typescript-eslint version)
  "no-unused-private-class-members": "error", // S1068 approx
  "no-useless-call": "error", // S6676 approx
  "no-useless-constructor": "error", // S6647 approx
  "no-useless-escape": "error", // S6535 approx
  "no-useless-rename": "error", // S6650
  "no-var": "error", // S3504 approx
  "no-with": "error", // S1321
  "prefer-object-has-own": "error", // S6653
  "prefer-object-spread": "error", // S6661 approx
  "prefer-regex-literals": "error", // S6325
  "prefer-spread": "error", // S6666 approx
  "use-isnan": "error", // S2688 approx
  "valid-typeof": "error", // S4125
};

// Borrowed eslint-plugin-import rules (all file types).
const SONAR_WAY_IMPORT_RULES = {
  "import/no-absolute-path": "error", // S6859 approx
  "import/no-duplicates": "error", // S3863
  "import/no-mutable-exports": "error", // S6861
  "import/no-self-import": "error", // S7060 approx
};

// Borrowed typescript-eslint rules (TS files only) — the non-type-aware subset. The first
// four replace their ESLint-core counterparts from SONAR_WAY_CORE_RULES on TS files, per
// typescript-eslint's extension-rule guidance. Type-aware borrowed rules (await-thenable,
// no-misused-promises, …) are NOT here: they need parserOptions.project(Service), which this
// base config lacks. They could be added to default.eslint.typed.config.mjs, where type info
// is available; the typed config already activates sonarjs's own type-aware rules.
const SONAR_WAY_TS_RULES = {
  "default-param-last": "off",
  "@typescript-eslint/default-param-last": "error", // S1788 approx
  "no-empty-function": "off",
  "@typescript-eslint/no-empty-function": "error", // S1186 approx
  "no-redeclare": "off",
  "@typescript-eslint/no-redeclare": "error", // S2814 approx
  "no-unused-expressions": "off",
  "@typescript-eslint/no-unused-expressions": "error", // S905 approx
  "@typescript-eslint/no-confusing-non-null-assertion": "error", // S6568
  "@typescript-eslint/no-duplicate-enum-values": "error", // S6578
  "@typescript-eslint/no-extraneous-class": ["error", { allowStaticOnly: true, allowWithDecorator: true }], // S2094 approx — Sonar flags empty classes, not static-only utility classes
  "@typescript-eslint/no-misused-new": "error", // S4124
  "@typescript-eslint/no-unnecessary-type-constraint": "error", // S6569
  "@typescript-eslint/prefer-as-const": "error", // S6590
  "@typescript-eslint/prefer-enum-initializers": "error", // S6572 approx
  "@typescript-eslint/prefer-for-of": "error", // S4138 approx
  "@typescript-eslint/prefer-function-type": "error", // S6598 approx
  "@typescript-eslint/prefer-literal-enum-member": "error", // S6550
  "@typescript-eslint/prefer-namespace-keyword": "error", // S4156 approx
};

export default [
  // Skip generated output up front: flat config only auto-ignores node_modules/ and .git/,
  // and findings in these dirs are excluded from fix scope anyway (scope-policy.ts derives
  // its exclusion list from the same shared module).
  { ignores: GENERATED_SEGMENTS.map((segment) => `**/${segment}/**`) },
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
    name: "tend/sonar-way-borrowed",
    files: ["**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}"],
    plugins: { import: importPlugin },
    rules: { ...SONAR_WAY_CORE_RULES, ...SONAR_WAY_IMPORT_RULES },
  },
  {
    files: ["**/*.{ts,mts,cts,tsx}"],
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      ...SONAR_WAY_TS_RULES,
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
