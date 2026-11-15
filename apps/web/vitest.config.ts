import { defineConfig } from 'vitest/config'

// Unit tests: pure helpers only, in Node (no DOM, no Univer).
// The station screens were checked by rendering them against a mocked API.
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
  },
})
