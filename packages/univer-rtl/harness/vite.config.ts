// Vite config for the RTL grid verification harness (harness/index.html).
// The page imports the layer from ../src, so the interaction suite
// (test/rtl-interactions.mjs) exercises the package's own copy.
//
//   npm run harness:build     builds into dist/harness
//   npm run harness:preview   serves the build on :4175 (the suite's default URL)
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  root: here('.'),
  build: {
    outDir: here('../dist/harness'),
    // The output directory lies outside the harness root; Vite only empties it when told to.
    emptyOutDir: true,
  },
  server: { port: 4175, strictPort: true },
  preview: { port: 4175, strictPort: true },
})
