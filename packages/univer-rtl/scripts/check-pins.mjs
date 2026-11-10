// Fails when Univer could change without the RTL layer being re-verified.
// Adapted from the phase 0 spike (spike/univer/check-pins.mjs) to the workspace:
//
//   - every dependency declared by any workspace (apps/*, packages/*) is
//     pinned to an exact version — a git dependency only to an exact
//     `#vX.Y.Z` tag (CLAUDE.md: naf-auth is a tag, never a branch);
//   - every @univerjs/* they declare equals VERIFIED_UNIVER_VERSION in
//     src/rtl-grid.ts (the API's workbook room runs Univer too, and the
//     server and the browser must apply the same mutations identically);
//   - every @univerjs/* the root package-lock.json installs, at any depth,
//     equals VERIFIED_UNIVER_VERSION too (one exception, by name, below).
//
// Raising Univer therefore means raising that constant too — in a pull request
// whose RTL CI is green.
import { existsSync, readdirSync, readFileSync } from 'node:fs'

const here = (p) => new URL(p, import.meta.url)
const readJson = (p) => JSON.parse(readFileSync(here(p), 'utf8'))
// Every workspace of the root package.json (`apps/*`, `packages/*`).
const MANIFESTS = {}
for (const group of ['apps', 'packages']) {
  for (const dir of readdirSync(here(`../../../${group}/`), { withFileTypes: true })) {
    const file = `${group}/${dir.name}/package.json`
    if (dir.isDirectory() && existsSync(here(`../../../${file}`))) MANIFESTS[file] = readJson(`../../../${file}`)
  }
}
const EXACT = /^(\d+\.\d+\.\d+|github:[\w.-]+\/[\w.-]+#v\d+\.\d+\.\d+)$/
const LOCKFILE = 'package-lock.json'
const lock = readJson('../../../package-lock.json')
const verified = /VERIFIED_UNIVER_VERSION = '([^']+)'/.exec(readFileSync(here('../src/rtl-grid.ts'), 'utf8'))?.[1]
// Published on their own version line, outside Univer's release train; still
// held exactly by the lockfile, and listed here by name rather than by pattern.
const INDEPENDENT = { '@univerjs/icons': '1.47.0' }
const problems = []
if (!verified) problems.push('VERIFIED_UNIVER_VERSION not found in packages/univer-rtl/src/rtl-grid.ts')
for (const [file, pkg] of Object.entries(MANIFESTS)) {
  const declared = { ...pkg.dependencies, ...pkg.devDependencies }
  for (const [name, range] of Object.entries(declared)) {
    if (!EXACT.test(range)) problems.push(`${file}: ${name} "${range}" is not an exact version`)
    if (name.startsWith('@univerjs/') && range !== verified) problems.push(`${file}: ${name} ${range} differs from VERIFIED_UNIVER_VERSION ${verified}`)
  }
}
let locked = 0
for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  const name = path.replace(/^.*node_modules\//, '')
  if (!name.startsWith('@univerjs/')) continue
  locked++
  const expected = INDEPENDENT[name] ?? verified
  if (entry.version !== expected) problems.push(`${LOCKFILE}: ${path}@${entry.version} differs from ${expected}`)
}
if (locked === 0) problems.push(`${LOCKFILE}: no @univerjs/* entries found (wrong lockfile?)`)
if (problems.length) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log(`ok: all @univerjs/* pinned to ${verified} (${locked} lockfile entries; ${Object.keys(MANIFESTS).join(', ')} exact)`)
