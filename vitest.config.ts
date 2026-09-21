import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { obsidian: "/test/obsidian.ts" } },
  // Mirrors `npm run dev`; see src/dev/globals.d.ts.
  define: { __DEV__: "true" },
});
