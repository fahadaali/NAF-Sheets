import { defineConfig } from 'vitest/config'

// Unit tests: pure helpers only, in Node (no DOM, no Univer).
// The browser smoke test has its own config: vitest.e2e.config.ts.
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
  },
})
