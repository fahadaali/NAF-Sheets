// checkUniverContract() against the Univer actually installed in this
// workspace: every internal the layer hooks must be present, and the installed
// release must be the one the layer was verified against.
//
// Node has no canvas, so the browser half of the contract
// (CanvasRenderingContext2D.direction and its drawing methods) is satisfied by
// a minimal stand-in here. Real browsers are covered by the first check of the
// interaction suite (test/rtl-interactions.mjs), which reads the same report
// from the page in Chromium, Firefox and WebKit.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Documents } from '@univerjs/engine-render'
import { MoveSelectionCommand } from '@univerjs/sheets-ui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkUniverContract, VERIFIED_UNIVER_VERSION } from '../src/index'

const CANVAS_METHODS = ['fillText', 'strokeText', 'drawImage', 'measureText'] as const

function canvasContextStandIn({ withDirection = true } = {}) {
  class Context2D {}
  const proto = Context2D.prototype as unknown as Record<string, unknown>
  for (const m of CANVAS_METHODS) proto[m] = () => {}
  if (withDirection) Object.defineProperty(proto, 'direction', { get: () => 'inherit', set: () => {}, configurable: true })
  return Context2D
}

/** Version from the package.json of the module Node resolves for `name`. */
function installedVersion(name: string): string {
  const require = createRequire(import.meta.url)
  let dir = dirname(require.resolve(name))
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version: string }
      if (pkg.name === name) return pkg.version
    } catch {
      // no package.json at this level
    }
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`package.json of ${name} not found`)
    dir = parent
  }
}

describe('checkUniverContract against the installed Univer', () => {
  beforeEach(() => {
    vi.stubGlobal('CanvasRenderingContext2D', canvasContextStandIn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('finds every hooked internal: no problems', () => {
    expect(checkUniverContract().problems).toEqual([])
  })

  it('reports the installed versions and accepts them as verified', () => {
    const report = checkUniverContract()
    expect(report.versions).toEqual({
      core: VERIFIED_UNIVER_VERSION,
      'engine-render': VERIFIED_UNIVER_VERSION,
      'sheets-ui': VERIFIED_UNIVER_VERSION,
    })
    expect(report.verifiedVersion).toBe(true)
  })

  it('reads the versions npm actually installed', () => {
    const report = checkUniverContract()
    expect(report.versions).toEqual({
      core: installedVersion('@univerjs/core'),
      'engine-render': installedVersion('@univerjs/engine-render'),
      'sheets-ui': installedVersion('@univerjs/sheets-ui'),
    })
  })

  it('reports a changed glyph-group hook (same behaviour, different signature)', () => {
    // As the harness does with ?simulateBreak=contract.
    const proto = Documents.prototype as unknown as { _drawGlyphGroup: (...a: unknown[]) => unknown }
    const original = proto._drawGlyphGroup
    proto._drawGlyphGroup = function (this: unknown, ...a: unknown[]) {
      return original.apply(this, a)
    }
    try {
      const { problems } = checkUniverContract()
      expect(problems).toHaveLength(1)
      expect(problems[0]).toMatch(/_drawGlyphGroup\(/)
    } finally {
      proto._drawGlyphGroup = original
    }
    expect(checkUniverContract().problems).toEqual([])
  })

  it('reports a command whose handler is gone', () => {
    const cmd = MoveSelectionCommand as unknown as { handler: unknown }
    const original = cmd.handler
    cmd.handler = undefined
    try {
      expect(checkUniverContract().problems).toEqual(['MoveSelectionCommand (id sheet.command.move-selection, handler)'])
    } finally {
      cmd.handler = original
    }
  })

  it('reports a browser without CanvasRenderingContext2D.direction', () => {
    vi.stubGlobal('CanvasRenderingContext2D', canvasContextStandIn({ withDirection: false }))
    expect(checkUniverContract().problems).toEqual(['CanvasRenderingContext2D.direction (browser)'])
  })
})
