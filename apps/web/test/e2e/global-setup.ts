// Builds the app with `vite build` and serves dist/ with `vite preview` on
// 127.0.0.1:4174 for the smoke test; stops the server afterwards.
// E2E_SKIP_BUILD=1 reuses an existing dist/.

import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PREVIEW_PORT = 4174
export const BASE_URL = `http://127.0.0.1:${PREVIEW_PORT}`

const webRoot = fileURLToPath(new URL('../..', import.meta.url))
// The Vite this package pins (apps/web/node_modules/vite), not a hoisted one.
const viteBin = join(dirname(createRequire(join(webRoot, 'package.json')).resolve('vite/package.json')), 'bin', 'vite.js')

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

async function waitForServer(url: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`vite preview exited with code ${child.exitCode}`)
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`vite preview did not answer on ${url} within ${timeoutMs} ms`)
}

export default async function setup(): Promise<() => Promise<void>> {
  if (!(await portIsFree(PREVIEW_PORT))) {
    throw new Error(`Port ${PREVIEW_PORT} is in use: stop the other preview server before running the smoke test.`)
  }
  if (process.env.E2E_SKIP_BUILD !== '1') {
    const build = spawnSync(process.execPath, [viteBin, 'build', '--logLevel', 'warn'], { cwd: webRoot, stdio: 'inherit' })
    if (build.status !== 0) throw new Error(`vite build failed (exit ${build.status})`)
  }

  const output: string[] = []
  const child = spawn(process.execPath, [viteBin, 'preview', '--port', String(PREVIEW_PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: webRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (d: Buffer) => output.push(d.toString()))
  child.stderr?.on('data', (d: Buffer) => output.push(d.toString()))
  try {
    await waitForServer(`${BASE_URL}/`, child, 30_000)
  } catch (error) {
    child.kill('SIGKILL')
    throw new Error(`${(error as Error).message}\n${output.join('')}`)
  }

  return async () => {
    if (child.exitCode !== null) return
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    await exited
    clearTimeout(timer)
  }
}
