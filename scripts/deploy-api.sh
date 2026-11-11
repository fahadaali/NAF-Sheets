#!/usr/bin/env bash
# Deploy command of the API Worker on Cloudflare Workers Builds
# (docs/cloudflare-setup.md §4). Runs from the repository root.
#
# No resource id is in wrangler.toml: `wrangler deploy` creates D1, KV, R2 and
# the queues on the first deploy and finds them again afterwards. The D1 schema
# (migrations/, forward-only) is applied before the code that needs it, except
# on the very first deploy, when the database does not exist until the deploy
# has created it.
set -euo pipefail

CONFIG=apps/api/wrangler.toml

if npx wrangler d1 info naf-sheets --config "$CONFIG" >/dev/null 2>&1; then
  npx wrangler d1 migrations apply naf-sheets --remote --config "$CONFIG"
  npx wrangler deploy --config "$CONFIG"
else
  echo "First deploy: creating the resources, then applying the D1 schema."
  npx wrangler deploy --config "$CONFIG"
  npx wrangler d1 migrations apply naf-sheets --remote --config "$CONFIG"
fi
