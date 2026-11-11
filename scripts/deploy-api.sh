#!/usr/bin/env bash
# Deploy command of the platform's one Worker on Cloudflare Workers Builds
# (docs/cloudflare-setup.md §4). Runs from the repository root. The Worker
# serves both the API and the web app (apps/web/dist, its static assets), so
# the web app is built first and both always go out in the same version.
#
# No resource id is in wrangler.toml: `wrangler deploy` creates D1, KV, R2 and
# the queues on the first deploy and finds them again afterwards. KV namespaces
# that exist but are not bound yet (a deploy that stopped half-way) are found
# by title first (scripts/resolve-kv.mjs). The D1 schema (migrations/,
# forward-only) is applied before the code that needs it, except on the very
# first deploy, when the database does not exist until the deploy creates it.
set -euo pipefail

CONFIG=apps/api/wrangler.toml
# Next to the original, so its relative paths (main, migrations_dir) still hold. Not committed.
DEPLOY_CONFIG=apps/api/wrangler.deploy.toml
LIST=$(mktemp)
trap 'rm -f "$LIST"' EXIT

npm run build -w @naf-sheets/web

npx wrangler kv namespace list --config "$CONFIG" > "$LIST"
node scripts/resolve-kv.mjs "$CONFIG" "$LIST" "$DEPLOY_CONFIG"

if npx wrangler d1 info naf-sheets --config "$CONFIG" >/dev/null 2>&1; then
  npx wrangler d1 migrations apply naf-sheets --remote --config "$CONFIG"
  npx wrangler deploy --config "$DEPLOY_CONFIG"
else
  echo "First deploy: creating the resources, then applying the D1 schema."
  npx wrangler deploy --config "$DEPLOY_CONFIG"
  npx wrangler d1 migrations apply naf-sheets --remote --config "$CONFIG"
fi
