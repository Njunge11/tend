import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
    globals: false,
    coverage: {
      provider: "v8",
      // `lcov` feeds SonarCloud (coverage/lcov.info); `text` prints a CI summary.
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/bin.ts", // CLI entry shim — nothing meaningful to cover
        "**/*.d.ts",
      ],
    },
  },
});
