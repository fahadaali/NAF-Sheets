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
  build: {
    // Univer is ~12 MB before compression. It is reachable only through the
    // lazily imported editor screen, so Rollup puts it in that chunk and the
    // files screen never loads it. No `manualChunks`: a manual Univer chunk
    // would also absorb React, and the entry would then import all of Univer.
    // The e2e smoke test checks the split.
    chunkSizeWarningLimit: 13_000,
  },
})
