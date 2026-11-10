import { defineConfig } from 'vitest/config'

// Load test of the editor (spec §15 phase 7): opens LOAD_WORKBOOKS workbooks of
// LOAD_SHEETS × LOAD_ROWS rows (defaults 10 × 7 × 500) in headless Chromium,
// against the mocked API, on the same preview server as the e2e tests (:4174).
//   cd apps/web && npx vitest run --config vitest.load.config.ts
// Results: `LOAD_RESULT {json}` lines on stdout (scripts/load-test.mjs).
export default defineConfig({
  test: {
    include: ['test/load/**/*.load.ts'],
    environment: 'node',
    globalSetup: ['test/e2e/global-setup.ts'],
    testTimeout: 60 * 60 * 1000,
    hookTimeout: 240_000,
    fileParallelism: false,
  },
})
