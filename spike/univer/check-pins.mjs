// Fails when Univer could change without the RTL layer being re-verified:
// every @univerjs/* dependency must be pinned exactly (package.json and
// lockfile), all to one version, and that version must equal
// VERIFIED_UNIVER_VERSION in src/rtl-grid.ts. Raising Univer therefore means
// raising that constant too — in a pull request whose RTL CI is green.
import { readFileSync } from 'node:fs'

const here = (p) => new URL(p, import.meta.url)
const pkg = JSON.parse(readFileSync(here('./package.json'), 'utf8'))
const lock = JSON.parse(readFileSync(here('./package-lock.json'), 'utf8'))
const verified = /VERIFIED_UNIVER_VERSION = '([^']+)'/.exec(readFileSync(here('./src/rtl-grid.ts'), 'utf8'))?.[1]
// Published on their own version line, outside Univer's release train; still
// held exactly by the lockfile, and listed here by name rather than by pattern.
const INDEPENDENT = { '@univerjs/icons': '1.47.0' }
const problems = []
if (!verified) problems.push('VERIFIED_UNIVER_VERSION not found in src/rtl-grid.ts')
const declared = { ...pkg.dependencies, ...pkg.devDependencies }
for (const [name, range] of Object.entries(declared)) {
  if (!/^\d+\.\d+\.\d+$/.test(range)) problems.push(`${name}: "${range}" is not an exact version`)
  if (name.startsWith('@univerjs/') && range !== verified) problems.push(`${name}: ${range} differs from VERIFIED_UNIVER_VERSION ${verified}`)
}
for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  const name = path.replace(/^.*node_modules\//, '')
  if (!name.startsWith('@univerjs/')) continue
  const expected = INDEPENDENT[name] ?? verified
  if (entry.version !== expected) problems.push(`lockfile ${name}@${entry.version} differs from ${expected}`)
}
if (problems.length) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log(`ok: all @univerjs/* pinned to ${verified}; every dependency exact`)
