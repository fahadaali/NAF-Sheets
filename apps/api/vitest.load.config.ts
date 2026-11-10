// Load test of the API (spec §15 phase 7: «اختبارات الحمل (10 ملفات × 7 أوراق ×
// 500 صف)»), on local Miniflare like every API test — nothing remote is
// called; Basecamp is the in-process fake of test/sync/fake-basecamp.ts.
//
//   cd apps/api && npx vitest run --config vitest.load.config.ts
//
// Size from the environment (defaults = the spec's figures):
//   LOAD_WORKBOOKS=10 LOAD_SHEETS=7 LOAD_ROWS=500
//   LOAD_SYNC_WORKBOOKS=<n>   how many of them go through linking + sync (default: all)
//   LOAD_ROOM_OPS=100         ops sent through each workbook's room
// Results: one `LOAD_RESULT {json}` line per phase on stdout, collected by
// scripts/load-test.mjs into docs/load-test-results-<timestamp>.json.

import { fileURLToPath } from 'node:url'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url))

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  const n = raw === undefined || raw === '' ? fallback : Number(raw)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

export default defineConfig(async () => {
  const migrations = await readD1Migrations(migrationsDir)
  const workbooks = intFromEnv('LOAD_WORKBOOKS', 10)
  const load = {
    workbooks,
    sheets: intFromEnv('LOAD_SHEETS', 7),
    rows: intFromEnv('LOAD_ROWS', 500),
    syncWorkbooks: Math.min(workbooks, intFromEnv('LOAD_SYNC_WORKBOOKS', workbooks)),
    roomOps: intFromEnv('LOAD_ROOM_OPS', 100),
  }
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations, LOAD_CONFIG: JSON.stringify(load) },
        },
      }),
    ],
    test: {
      include: ['test/load/**/*.load.ts'],
      setupFiles: ['./test/apply-migrations.ts'],
      testTimeout: 6 * 60 * 60 * 1000,
      hookTimeout: 10 * 60 * 1000,
      fileParallelism: false,
    },
  }
})
