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
          // PLATFORM_ID is a dashboard variable in production (wrangler.toml keep_vars).
          bindings: { TEST_MIGRATIONS: migrations, PLATFORM_ID: 'naf-sheets-test' },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
    },
  }
})
