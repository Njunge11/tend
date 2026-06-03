import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/bin.ts", "src/index.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  dts: true,
});
