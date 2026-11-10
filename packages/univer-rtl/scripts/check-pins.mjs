// Fails when Univer could change without the RTL layer being re-verified.
// Adapted from the phase 0 spike (spike/univer/check-pins.mjs) to the workspace:
//
//   - every dependency declared by this package and by apps/web (the
//     application that ships the layer) is pinned to an exact version;
//   - every @univerjs/* they declare equals VERIFIED_UNIVER_VERSION in
//     src/rtl-grid.ts;
//   - every @univerjs/* the root package-lock.json installs, at any depth,
//     equals VERIFIED_UNIVER_VERSION too (one exception, by name, below).
//
// Raising Univer therefore means raising that constant too — in a pull request
// whose RTL CI is green.
import { readFileSync } from 'node:fs'

const here = (p) => new URL(p, import.meta.url)
const readJson = (p) => JSON.parse(readFileSync(here(p), 'utf8'))
const MANIFESTS = {
  'packages/univer-rtl/package.json': readJson('../package.json'),
  'apps/web/package.json': readJson('../../../apps/web/package.json'),
}
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
    if (!/^\d+\.\d+\.\d+$/.test(range)) problems.push(`${file}: ${name} "${range}" is not an exact version`)
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
