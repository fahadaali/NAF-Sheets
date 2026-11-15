import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The API (apps/api, `wrangler dev`) serves /api on the same origin in
// production (packages/shared/src/api.ts: "Paths are relative to the platform
// origin"). In development the Vite server forwards /api to it.
const apiOrigin = process.env.NAF_API_ORIGIN ?? 'http://127.0.0.1:8787'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': { target: apiOrigin } },
  },
  preview: {
    port: 4174,
    strictPort: true,
  },
})
