// Unit tests only: the pure helpers and the static Univer contract of
// src/rtl-grid.ts. The browser interaction suite (test/rtl-interactions.mjs)
// runs separately through `npm run test:rtl` against the harness page.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
