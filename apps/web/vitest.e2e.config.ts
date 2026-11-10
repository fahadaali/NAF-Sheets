import { defineConfig } from 'vitest/config'

// Browser smoke test: builds the app (`vite build`), serves it with
// `vite preview` on :4174 and drives it in headless Chromium through the
// `playwright` library, with the API mocked by route interception.
// Chromium must already be installed (PLAYWRIGHT_BROWSERS_PATH); this never
// downloads browsers.
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['test/e2e/global-setup.ts'],
    testTimeout: 90_000,
    hookTimeout: 240_000,
    fileParallelism: false,
  },
})
