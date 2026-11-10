// Room client unit tests (Node, no browser, no Univer):
//   cd apps/web && npx vitest run --config test/collab/vitest.config.ts
// Kept apart from vitest.config.ts (owned by the editor work); the end-to-end
// two-editor tests against the real room live in apps/api/test/room.
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    include: ['test/collab/**/*.test.ts'],
    environment: 'node',
  },
})
