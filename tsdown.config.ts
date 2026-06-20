import { defineConfig } from "tsdown";

export default defineConfig({
  // eslint-worker is a separate entry: tend spawns it as a child process so type-aware linting's
  // huge TypeScript program lives in a short-lived heap, not tend's own (see runEslintSonarjs).
  entry: ["src/bin.ts", "src/index.ts", "src/scanners/eslint-worker.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  dts: true,
});
