// Build-time step of scripts/deploy-api.sh: writes a copy of the Worker's
// config with the ids of KV namespaces that already exist in the account.
//
// No KV id is kept in the repository (owner, 2026-11-11). `wrangler deploy`
// creates a missing namespace as `<worker>-<binding>` and binds it. But if a
// deploy stops after creating one and before binding it, the next deploy in CI
// tries to create it again and Cloudflare refuses ("a namespace with this
// account ID and title already exists"). So, before deploying, every KV binding
// without an id gets the id of the namespace with that title, when one exists;
// the others are left to wrangler to create.
//
// Usage: node scripts/resolve-kv.mjs <config> <namespaces.json> <output>
import { readFileSync, writeFileSync } from 'node:fs'

const [configPath, listPath, outPath] = process.argv.slice(2)
if (!configPath || !listPath || !outPath) {
  console.error('usage: node scripts/resolve-kv.mjs <config> <namespaces.json> <output>')
  process.exit(2)
}

const toml = readFileSync(configPath, 'utf8')
const raw = readFileSync(listPath, 'utf8')
const namespaces = JSON.parse(raw.slice(raw.indexOf('[')))
const worker = /^name\s*=\s*"([^"]+)"/m.exec(toml)?.[1]
if (!worker) throw new Error(`no Worker name in ${configPath}`)

// Same rule as wrangler's autoProvisionedResourceName (wrangler 4.124.0).
const titleFor = (binding) => `${worker}-${binding.toLowerCase().replaceAll('_', '-')}`

let out = toml
// A [[kv_namespaces]] block: its binding line, and no id line before the next table.
out = out.replace(/\[\[kv_namespaces\]\]\nbinding = "([A-Z0-9_]+)"\n(?!id\s*=)/g, (block, binding) => {
  const title = titleFor(binding)
  const found = namespaces.find((ns) => ns.title === title)
  if (!found) {
    console.log(`KV ${binding}: no namespace "${title}" yet; wrangler will create it.`)
    return block
  }
  console.log(`KV ${binding}: using the existing namespace "${title}".`)
  return `${block.trimEnd()}\nid = "${found.id}"\n`
})
writeFileSync(outPath, out)
