// Conflict rules of the room (pure), the server-change plan, frame chunking,
// and the allow-list checked against the Univer 1.4.0 the room loads.

import { describe, expect, it } from 'vitest'
import { FrameAssembler, ROOM_MUTATIONS, isStructuralOp, roomMutationClass, toFrames } from '@naf-sheets/shared'
import type { RoomChunk } from '@naf-sheets/shared'
import { classifyOp, footprintTouchesCell, footprintsConflict } from '../../src/room/footprint'
import type { Footprint } from '../../src/room/footprint'
import { cellMutations, cellsMatch, planServerChange } from '../../src/room/server-change'
import { parseClientMessage } from '../../src/room'
import { loadHeadlessWorkbook } from '../../src/room/engine'
import { realisticWorkbook, sheetId } from './fixtures'

const U = 'wb-1'
const S = 'sheet-1'

function fp(mutations: Array<{ id: string; params: Record<string, unknown> }>): Footprint {
  const out = classifyOp(mutations, U)
  if (!out.ok) throw new Error(out.detail)
  return out.footprint
}

const values = (cells: Record<number, Record<number, unknown>>, sheet = S) => ({ id: 'sheet.mutation.set-range-values', params: { unitId: U, subUnitId: sheet, cellValue: cells } })

describe('footprints', () => {
  it('reads the cells of a value matrix as runs of adjacent columns', () => {
    expect(fp([values({ 1: { 0: { v: 1 }, 1: { v: 2 }, 3: { v: 3 } }, 4: { 2: null } })]).cells).toEqual([
      { sheet: S, r0: 1, r1: 1, c0: 0, c1: 1 },
      { sheet: S, r0: 1, r1: 1, c0: 3, c1: 3 },
      { sheet: S, r0: 4, r1: 4, c0: 2, c1: 2 },
    ])
  })

  it('reads whole rows and whole columns from range types', () => {
    const merge = (range: Record<string, unknown>) => ({ id: 'sheet.mutation.add-worksheet-merge', params: { unitId: U, subUnitId: S, ranges: [range] } })
    const MAX = 2 ** 31
    expect(fp([merge({ startRow: 2, endRow: 3, startColumn: 0, endColumn: 1 })]).cells).toEqual([{ sheet: S, r0: 2, r1: 3, c0: 0, c1: 1 }])
    expect(fp([merge({ startRow: 2, endRow: 3, startColumn: Number.NaN, endColumn: Number.NaN, rangeType: 1 })]).cells).toEqual([{ sheet: S, r0: 2, r1: 3, c0: 0, c1: MAX }])
    expect(fp([merge({ startRow: Number.NaN, endRow: Number.NaN, startColumn: 4, endColumn: 4, rangeType: 2 })]).cells).toEqual([{ sheet: S, r0: 0, r1: MAX, c0: 4, c1: 4 }])
  })

  it('classifies rows, columns, sheet, workbook and plugin keys', () => {
    const range = [{ startRow: 5, endRow: 6, startColumn: 0, endColumn: 0 }]
    expect(fp([{ id: 'sheet.mutation.set-worksheet-row-height', params: { unitId: U, subUnitId: S, ranges: range, rowHeight: 30 } }]).rows).toHaveLength(1)
    expect(fp([{ id: 'sheet.mutation.set-worksheet-col-width', params: { unitId: U, subUnitId: S, ranges: range, colWidth: 90 } }]).columns).toHaveLength(1)
    expect(fp([{ id: 'sheet.mutation.set-worksheet-name', params: { unitId: U, subUnitId: S, name: 'x' } }]).keys).toEqual([`sheet:${S}`])
    expect(fp([{ id: 'sheet.mutation.set-worksheet-order', params: { unitId: U, subUnitId: S, fromOrder: 0, toOrder: 1 } }]).keys).toEqual(['workbook'])
    expect(fp([{ id: 'data-validation.mutation.addRule', params: { unitId: U, subUnitId: S, rule: {} } }]).keys).toEqual([`dv:${S}`])
    expect(fp([{ id: 'sheet.mutation.update-note', params: { unitId: U, sheetId: S, row: 1, col: 1, note: {} } }]).keys).toEqual([`note:${S}`])
    expect(fp([{ id: 'sheets.mutation.remove-hyper-link', params: { unitId: U, subUnitId: S, id: 'l1' } }]).keys).toEqual([`link:${S}`])
    expect(fp([{ id: 'sheet.mutation.insert-row', params: { unitId: U, subUnitId: S, range: range[0] } }]).structural).toBe(true)
  })

  it('refuses an id outside the allow-list, another unit, a missing sheet or a malformed matrix', () => {
    expect(classifyOp([{ id: 'formula.mutation.set-formula-data', params: { unitId: U } }], U).ok).toBe(false)
    expect(classifyOp([{ ...values({ 1: { 1: { v: 1 } } }), params: { ...values({}).params, unitId: 'other' } }], U).ok).toBe(false)
    expect(classifyOp([{ id: 'sheet.mutation.set-tab-color', params: { unitId: U, color: 'x' } }], U).ok).toBe(false)
    expect(classifyOp([values({ 1: { a: { v: 1 } } } as never)], U).ok).toBe(false)
    expect(classifyOp([{ id: 'sheet.mutation.set-worksheet-row-height', params: { unitId: U, subUnitId: S, ranges: [{ startRow: 3, endRow: 1, startColumn: 0, endColumn: 0 }] } }], U).ok).toBe(false)
  })
})

describe('conflicts', () => {
  const a = fp([values({ 1: { 1: { v: 1 } } })])
  it('overlapping cells conflict; different cells, sheets or kinds do not', () => {
    expect(footprintsConflict(a, fp([values({ 1: { 1: { v: 2 } } })]))).toBe(true)
    expect(footprintsConflict(a, fp([values({ 1: { 2: { v: 2 } } })]))).toBe(false)
    expect(footprintsConflict(a, fp([values({ 1: { 1: { v: 2 } } }, 'sheet-2')]))).toBe(false)
    const height = fp([{ id: 'sheet.mutation.set-worksheet-row-height', params: { unitId: U, subUnitId: S, ranges: [{ startRow: 1, endRow: 1, startColumn: 0, endColumn: 0 }], rowHeight: 40 } }])
    expect(footprintsConflict(a, height)).toBe(false)
    expect(footprintsConflict(height, height)).toBe(true)
  })

  it('a structural op conflicts with everything', () => {
    const insert = fp([{ id: 'sheet.mutation.insert-col', params: { unitId: U, subUnitId: 'sheet-9', range: { startRow: 0, endRow: 999, startColumn: 3, endColumn: 3 } } }])
    expect(footprintsConflict(a, insert)).toBe(true)
    expect(footprintsConflict(insert, a)).toBe(true)
    expect(footprintTouchesCell(insert, { sheetId: S, row: 900, column: 20 })).toBe(true)
  })

  it('a huge op is kept as one bounding span per sheet', () => {
    const cells: Record<number, Record<number, unknown>> = {}
    for (let r = 0; r < 5000; r += 2) cells[r] = { 0: { v: r } }
    const big = fp([values(cells)])
    expect(big.cells).toEqual([{ sheet: S, r0: 0, r1: 4998, c0: 0, c1: 0 }])
    expect(footprintTouchesCell(big, { sheetId: S, row: 1, column: 0 })).toBe(true)
  })

  it('isStructuralOp agrees with the allow-list', () => {
    expect(isStructuralOp([{ id: 'sheet.mutation.move-rows' }])).toBe(true)
    expect(isStructuralOp([{ id: 'sheet.mutation.set-range-values' }])).toBe(false)
    expect(roomMutationClass('toString')).toBeNull()
  })
})

describe('server-change plan', () => {
  const base = () => ({
    id: U,
    name: 'خطة',
    styles: { b: { bl: 1 } },
    sheetOrder: [S],
    sheets: { [S]: { id: S, name: 'ورقة 1', rowCount: 100, cellData: { 0: { 0: { v: 'المهمة', s: 'b' } }, 1: { 0: { v: 'أ' }, 2: { v: 3 } } } } },
    resources: [{ name: 'SHEET_NOTE_PLUGIN', data: '{}' }],
  })

  it('plans cell changes (styles resolved), and none for an identical snapshot', () => {
    const after = base()
    after.sheets[S]!.cellData[1]![0] = { v: 'ب', s: 'b' } as never
    delete (after.sheets[S]!.cellData[1] as Record<number, unknown>)[2]
    expect(planServerChange(base(), after)).toEqual({
      kind: 'cells',
      cells: [
        { sheet: S, row: 1, column: 0, cell: { v: 'ب', s: { bl: 1 } } },
        { sheet: S, row: 1, column: 2, cell: null },
      ],
    })
    expect(planServerChange(base(), base())).toEqual({ kind: 'none' })
    // Resources Univer saves as empty count as absent.
    expect(planServerChange(base(), { ...base(), resources: [] })).toEqual({ kind: 'none' })
  })

  it('plans a reload for rows, sheets, resources or workbook properties', () => {
    const rows = base()
    ;(rows.sheets[S] as Record<string, unknown>).rowData = { 3: { h: 40 } }
    expect(planServerChange(base(), rows).kind).toBe('reset')
    expect(planServerChange(base(), { ...base(), sheetOrder: [S, 'x'], sheets: { ...base().sheets, x: { id: 'x' } } as never }).kind).toBe('reset')
    expect(planServerChange(base(), { ...base(), resources: [{ name: 'SHEET_NOTE_PLUGIN', data: '{"a":1}' }] }).kind).toBe('reset')
    expect(planServerChange(base(), { ...base(), name: 'اسم آخر' }).kind).toBe('reset')
  })

  it('the planned mutations reproduce the cells in a headless Univer, and the check notices a mismatch', async () => {
    const data = realisticWorkbook({ workbookId: U, taskSheets: 1, rows: 20 })
    const wb = loadHeadlessWorkbook(data)
    try {
      const before = wb.snapshot()
      const after = structuredClone(before) as { sheets: Record<string, { cellData: Record<number, Record<number, unknown>> }> }
      after.sheets[sheetId(0)]!.cellData[2]![1] = { v: 'جديد', s: { it: 1 } }
      after.sheets[sheetId(0)]!.cellData[3]![8] = { f: '=D4-1' }
      delete after.sheets[sheetId(0)]!.cellData[4]![0]
      const plan = planServerChange(before, after as never)
      if (plan.kind !== 'cells') throw new Error(plan.kind)
      expect(plan.cells).toHaveLength(3)
      expect(wb.apply(cellMutations(wb.unitId, plan.cells)).failedAt).toBe(-1)
      expect(cellsMatch(wb.snapshot(), plan.cells)).toBe(true)
      expect(cellsMatch(wb.snapshot(), [{ ...plan.cells[0]!, cell: { v: 'غيره' } }])).toBe(false)
    } finally {
      wb.dispose()
    }
  })
})

describe('framing and parsing', () => {
  it('splits long messages into chunks and reassembles them', () => {
    const text = JSON.stringify({ type: 'welcome', big: 'ق'.repeat(1000) })
    const frames = toFrames(text, 'm1', 300)
    expect(frames.length).toBeGreaterThan(3)
    const assembler = new FrameAssembler(10_000)
    const results = frames.map((f) => assembler.push(JSON.parse(f) as RoomChunk))
    expect(results.slice(0, -1).every((r) => r === null)).toBe(true)
    expect(results.at(-1)).toBe(text)
    expect(toFrames('{"type":"pong"}', 'x')).toEqual(['{"type":"pong"}'])
  })

  it('refuses out-of-order or oversized chunks', () => {
    const frames = toFrames('x'.repeat(1000), 'm', 100).map((f) => JSON.parse(f) as RoomChunk)
    const a = new FrameAssembler(10_000)
    a.push(frames[0]!)
    expect(() => a.push(frames[2]!)).toThrow()
    const small = new FrameAssembler(150)
    small.push(frames[0]!)
    expect(() => small.push(frames[1]!)).toThrow()
  })

  it('parses only well-formed client messages', () => {
    expect(parseClientMessage('{"type":"hello","protocol":1,"clientId":"abcdefgh12","seq":null}')).toMatchObject({ type: 'hello' })
    expect(parseClientMessage('{"type":"hello","protocol":1,"clientId":"short","seq":null}')).toBeNull()
    expect(parseClientMessage('{"type":"op","opId":"o","baseSeq":-1,"epoch":1,"mutations":[{"id":"x","params":{}}]}')).toBeNull()
    expect(parseClientMessage('{"type":"op","opId":"o","baseSeq":0,"epoch":1,"mutations":[]}')).toBeNull()
    expect(parseClientMessage('{"type":"presence","cell":{"sheetId":"s","row":1.5,"column":0}}')).toBeNull()
    expect(parseClientMessage('{"type":"lock","cell":{"sheetId":"s","row":1,"column":0}}')).toEqual({ type: 'lock', cell: { sheetId: 's', row: 1, column: 0 } })
    expect(parseClientMessage('{"type":"op","opId":"o","baseSeq":0,"epoch":1,"mutations":[{"id":"x","params":{}}],"confirmedDeletions":["u-1","u-1","u-2"]}')).toMatchObject({ confirmedDeletions: ['u-1', 'u-2'] })
    expect(parseClientMessage('{"type":"op","opId":"o","baseSeq":0,"epoch":1,"mutations":[{"id":"x","params":{}}],"confirmedDeletions":"all"}')).toBeNull()
    expect(parseClientMessage('{"type":"op","opId":"o","baseSeq":0,"epoch":1,"mutations":[{"id":"x","params":{}}],"confirmedDeletions":[""]}')).toBeNull()
    expect(parseClientMessage('{"type":"hello","protocol":1,"clientId":"abcdefgh12","seq":null,"version":-1}')).toBeNull()
    expect(parseClientMessage('{"type":"nope"}')).toBeNull()
    expect(parseClientMessage('[1]')).toBeNull()
  })
})

describe('Univer contract', () => {
  it('every accepted mutation id is a registered mutation of Univer 1.4.0 in the room', () => {
    const wb = loadHeadlessWorkbook(realisticWorkbook({ workbookId: U, taskSheets: 1, rows: 2 }))
    try {
      const missing = Object.keys(ROOM_MUTATIONS).filter((id) => !wb.isMutation(id))
      expect(missing).toEqual([])
    } finally {
      wb.dispose()
    }
  })
})
