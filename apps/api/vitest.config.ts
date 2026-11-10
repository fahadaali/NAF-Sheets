// Tests run inside workerd with real local D1 / R2 / KV / Queues / Durable
// Objects (Miniflare), configured from wrangler.toml. Nothing remote is called.

import { fileURLToPath } from 'node:url'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url))

export default defineConfig(async () => {
  const migrations = await readD1Migrations(migrationsDir)
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          // Read by test/apply-migrations.ts.
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
    },
  }
})
