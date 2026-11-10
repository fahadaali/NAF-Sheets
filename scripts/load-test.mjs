#!/usr/bin/env node
// Load test runner (spec §15 phase 7; docs/load-test.md).
//
//   node scripts/load-test.mjs                 API (Miniflare) then editor (Chromium)
//   node scripts/load-test.mjs api|web         one part only
//
// Size: LOAD_WORKBOOKS (10), LOAD_SHEETS (7), LOAD_ROWS (500),
// LOAD_SYNC_WORKBOOKS (all), LOAD_ROOM_OPS (100). Everything runs locally;
// nothing remote is called (Basecamp is the in-process fake, the editor's API
// is mocked). Results: docs/load-test-results.json — a new file per run
// (`load-test-results-<timestamp>.json`), so a previous run is never replaced.
//
// Do not run the editor part while `npm run test:e2e` is running: both use
// the preview server on port 4174.

import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const which = process.argv[2] ?? 'all'

const parts = [
  { name: 'api', cwd: join(root, 'apps/api'), args: ['vitest', 'run', '--config', 'vitest.load.config.ts', '--reporter=verbose'] },
  { name: 'web', cwd: join(root, 'apps/web'), args: ['vitest', 'run', '--config', 'vitest.load.config.ts', '--reporter=verbose'] },
].filter((p) => which === 'all' || p.name === which)

function run(part) {
  return new Promise((resolve) => {
    const started = Date.now()
    const results = []
    const durations = {}
    const child = spawn('npx', part.args, { cwd: part.cwd, env: process.env, stdio: ['ignore', 'pipe', 'inherit'] })
    let buffer = ''
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk)
      buffer += chunk.toString()
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        const at = line.indexOf('LOAD_RESULT ')
        if (at >= 0) results.push(JSON.parse(line.slice(at + 'LOAD_RESULT '.length)))
        // Vitest's verbose line: "✓ file > suite > 3. link … 123456ms"
        const done = /[✓×] .* > ([^>]+?) (\d+)ms\s*$/.exec(line)
        if (done) durations[done[1].trim()] = Number(done[2])
      }
    })
    child.on('close', (code) => resolve({ part: part.name, exitCode: code, wallMs: Date.now() - started, testWallMs: durations, results }))
  })
}

const out = { startedAt: new Date().toISOString(), node: process.version, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('LOAD_'))), parts: [] }
for (const part of parts) out.parts.push(await run(part))
out.finishedAt = new Date().toISOString()
const file = join(root, 'docs', `load-test-results-${out.startedAt.replace(/[:.]/g, '-')}.json`)
writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`)
console.log(`\nload test results: ${file}`)
process.exit(out.parts.every((p) => p.exitCode === 0) ? 0 : 1)
