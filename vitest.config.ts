import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Everything runs here under vitest EXCEPT bun-only tests, which run via
    // `test:bun` (they use real `Bun.serve` / `bun:sqlite` / `bun:test`):
    //  - `*.bun.test.ts` files (e.g. transport-ws's live WebSocket server test)
    //  - packages whose code imports Bun-only modules (`bun:sqlite`)
    exclude: [
      ...configDefaults.exclude,
      "**/*.bun.test.ts",
      "packages/storage-sqlite/**",
      "packages/trace-store/**",
      "packages/observability-collector/**",
    ],
  },
});
