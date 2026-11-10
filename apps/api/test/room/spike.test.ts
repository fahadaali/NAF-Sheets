// Phase 6 feasibility spike: headless Univer 1.4.0 inside workerd (local
// Miniflare, through @cloudflare/vitest-pool-workers like every API test).
// It must load a realistic workbook, compute its formulas and apply editor
// mutations authoritatively. Timings are printed for the report; the
// assertions are about behaviour, not speed (local timings are not production).

import { describe, expect, it } from 'vitest'
import { loadHeadlessWorkbook } from '../../src/room/engine'
import { SUMMARY_SHEET, realisticWorkbook, setCell, sheetId } from './fixtures'

type Snap = { sheets: Record<string, { cellData: Record<number, Record<number, { v?: unknown; f?: string }>> }>; resources?: Array<{ name: string; data: string }> }

const clock = () => performance.now()

describe('spike: headless Univer in workerd', () => {
  it('reports whether the clock advances during synchronous work (workerd may freeze it)', async () => {
    const t0 = clock()
    let x = 0
    for (let i = 0; i < 3e7; i++) x = (x + i * 7) % 1000003
    const t1 = clock()
    await new Promise((r) => setTimeout(r, 0))
    const t2 = clock()
    console.log(`[spike] clock: sync-loop delta ${(t1 - t0).toFixed(1)} ms, after setTimeout ${(t2 - t0).toFixed(1)} ms (x=${x})`)
    expect(t2).toBeGreaterThanOrEqual(t0)
  })

  for (const plugins of ['minimal', 'model'] as const) {
    it(`loads a realistic workbook, computes formulas and applies mutations (${plugins} plugins)`, async () => {
      const data = realisticWorkbook({ workbookId: 'wb-spike', taskSheets: 3, rows: 300 })
      const json = JSON.stringify(data)
      // Poison cached formula values: only the engine can make the checks pass.
      const t0 = clock()
      const wb = loadHeadlessWorkbook(data, { plugins })
      await new Promise((r) => setTimeout(r, 0))
      const t1 = clock()
      const idle = await wb.settle(15_000)
      const t2 = clock()
      expect(idle).toBe(true)

      const snap = wb.snapshot() as unknown as Snap
      // 3 sheets × 300 rows; budgets 1000 + (r*37 % 9000).
      expect(snap.sheets[SUMMARY_SHEET]!.cellData[1]![1]!.v).toBe(300)
      const budget = Array.from({ length: 300 }, (_, i) => 1000 + (((i + 1) * 37) % 9000)).reduce((a, b) => a + b, 0)
      expect(snap.sheets[SUMMARY_SHEET]!.cellData[1]![2]!.v).toBe(budget)
      if (plugins === 'model') {
        expect(snap.resources?.map((r) => r.name)).toEqual(expect.arrayContaining(['SHEET_NOTE_PLUGIN', 'SHEET_DATA_VALIDATION_PLUGIN']))
      }

      // Per-mutation apply: 200 single-cell edits on the budget column, then settle.
      const n = 200
      const t3 = clock()
      for (let i = 0; i < n; i++) {
        const row = 1 + (i % 300)
        const out = wb.apply([setCell(wb.unitId, sheetId(0), row, 7, { v: 5000, t: 2 })])
        expect(out.failedAt).toBe(-1)
      }
      await new Promise((r) => setTimeout(r, 0))
      const t4 = clock()
      expect(await wb.settle(15_000)).toBe(true)
      const t5 = clock()
      const after = wb.snapshot() as unknown as Snap
      const rowsChanged = new Set(Array.from({ length: n }, (_, i) => 1 + (i % 300)))
      const expected = Array.from({ length: 300 }, (_, i) => (rowsChanged.has(i + 1) ? 5000 : 1000 + (((i + 1) * 37) % 9000))).reduce((a, b) => a + b, 0)
      expect(after.sheets[SUMMARY_SHEET]!.cellData[1]![2]!.v).toBe(expected)
      // A formula cell edited through a mutation computes too.
      wb.apply([setCell(wb.unitId, SUMMARY_SHEET, 10, 0, { f: '=B2*2' })])
      await wb.settle()
      expect((wb.snapshot() as unknown as Snap).sheets[SUMMARY_SHEET]!.cellData[10]![0]!.v).toBe(600)

      const t6 = clock()
      const saved = JSON.stringify(wb.snapshot())
      const t7 = clock()
      wb.dispose()
      console.log(
        `[spike] plugins=${plugins} fixture=${(json.length / 1024).toFixed(0)} KiB load=${(t1 - t0).toFixed(1)} ms ` +
          `firstCalc=${(t2 - t1).toFixed(1)} ms apply ${n} muts=${(t4 - t3).toFixed(1)} ms (${((t4 - t3) / n).toFixed(2)} ms each) ` +
          `recalc=${(t5 - t4).toFixed(1)} ms save=${(t7 - t6).toFixed(1)} ms saved=${(saved.length / 1024).toFixed(0)} KiB`,
      )
    }, 60_000)
  }
})
