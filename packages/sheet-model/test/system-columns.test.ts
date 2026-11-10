import { describe, expect, it } from 'vitest'
import { ensureSystemColumns, findSystemColumns, SYSTEM_HEADERS } from '../src'
import { blankWorkbook, cell, counterUids, defaultPlan, putRow } from './helpers'

const S = 'sheet-1'

function sheetWithTasks() {
  const wb = blankWorkbook()
  putRow(wb, S, 1, { A: 'إعداد الخطة', D: 46336 })
  putRow(wb, S, 2, { A: 'تصميم المنشور', H: 5 }) // user value in column H
  putRow(wb, S, 3, { B: 'سارة' }) // no title: not a task
  putRow(wb, S, 4, { A: 'المجموع', E: { f: '=COUNTA(A2:A4)', v: 3 } })
  return wb
}

describe('ensureSystemColumns', () => {
  it('adds __uid, __parent_uid, __level right after the last used column, hidden, without touching user cells', () => {
    const wb = sheetWithTasks()
    const before = structuredClone(wb)
    const result = ensureSystemColumns(wb.sheets[S] as never, defaultPlan(S), counterUids())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { sheet, columns, assigned } = result.value
    // Columns A..H are used (H holds a value): system columns are I, J, K.
    expect(columns).toEqual({ uid: 8, parentUid: 9, level: 10 })
    const header = (sheet.cellData as Record<number, Record<number, { v: unknown }>>)[0]
    expect([header?.[8]?.v, header?.[9]?.v, header?.[10]?.v]).toEqual([SYSTEM_HEADERS.uid, SYSTEM_HEADERS.parentUid, SYSTEM_HEADERS.level])
    expect((sheet.columnData as Record<number, { hd?: number }>)[8]?.hd).toBe(1)
    expect((sheet.columnData as Record<number, { hd?: number }>)[9]?.hd).toBe(1)
    expect((sheet.columnData as Record<number, { hd?: number }>)[10]?.hd).toBe(1)
    // Rows with a title get a uid (level 0, no parent); the row without a title does not.
    expect(assigned).toEqual([
      { row: 1, uid: 'u-1' },
      { row: 2, uid: 'u-2' },
      { row: 4, uid: 'u-3' },
    ])
    const rows = sheet.cellData as Record<number, Record<number, { v?: unknown; f?: unknown }>>
    expect(rows[1]?.[8]?.v).toBe('u-1')
    expect(rows[1]?.[10]?.v).toBe(0)
    expect(rows[1]?.[9]).toBeUndefined()
    expect(rows[3]?.[8]).toBeUndefined()
    // User cells, formulas included, are exactly as they were.
    for (const r of [0, 1, 2, 3, 4]) {
      for (let c = 0; c <= 7; c++) expect(rows[r]?.[c]).toEqual((before.sheets[S]?.cellData as typeof rows)[r]?.[c])
    }
    expect(rows[4]?.[4]).toEqual({ f: '=COUNTA(A2:A4)', v: 3 })
    // The input is not changed.
    expect(wb).toEqual(before)
  })

  it('is idempotent and keeps existing identities', () => {
    const wb = sheetWithTasks()
    const first = ensureSystemColumns(wb.sheets[S] as never, defaultPlan(S), counterUids('a'))
    if (!first.ok) throw new Error()
    const second = ensureSystemColumns(first.value.sheet, defaultPlan(S), counterUids('b'))
    expect(second.ok && second.value.assigned).toEqual([])
    expect(second.ok && second.value.sheet).toEqual(first.value.sheet)
    // A new task row gets a new uid; the others keep theirs.
    const sheet = structuredClone(first.value.sheet)
    ;(sheet.cellData as Record<number, Record<number, unknown>>)[5] = { 0: { v: 'مهمة جديدة' } }
    const third = ensureSystemColumns(sheet, defaultPlan(S), counterUids('c'))
    expect(third.ok && third.value.assigned).toEqual([{ row: 5, uid: 'c-1' }])
    expect(third.ok && (third.value.sheet.cellData as Record<number, Record<number, { v: unknown }>>)[1]?.[8]?.v).toBe('a-1')
  })

  it('places the columns after merges and formatted columns too', () => {
    const wb = blankWorkbook()
    wb.sheets[S]!.mergeData = [{ startRow: 3, endRow: 3, startColumn: 0, endColumn: 9 }]
    wb.sheets[S]!.columnData = { 12: { w: 200 } }
    const result = ensureSystemColumns(wb.sheets[S] as never, defaultPlan(S), counterUids())
    expect(result.ok && result.value.columns).toEqual({ uid: 13, parentUid: 14, level: 15 })
  })

  it('takes subtask levels from the import wizard, parent = the to-do right above', () => {
    const wb = blankWorkbook()
    putRow(wb, S, 1, { A: 'حملة الإطلاق' })
    putRow(wb, S, 2, { A: '  تصميم' })
    putRow(wb, S, 3, { A: '  نشر' })
    putRow(wb, S, 4, { A: 'تقرير' })
    const plan = defaultPlan(S, { hierarchy: { mode: 'indent' } })
    const levels = [
      { row: 2, level: 1 as const, parentRow: 1 },
      { row: 3, level: 1 as const, parentRow: 1 },
    ]
    const result = ensureSystemColumns(wb.sheets[S] as never, plan, counterUids(), { levels })
    if (!result.ok) throw new Error(result.error.message)
    const rows = result.value.sheet.cellData as Record<number, Record<number, { v?: unknown }>>
    // A..G are used: the system columns are H, I, J.
    expect(result.value.columns).toEqual({ uid: 7, parentUid: 8, level: 9 })
    expect([rows[2]?.[7]?.v, rows[2]?.[8]?.v, rows[2]?.[9]?.v]).toEqual(['u-2', 'u-1', 1])
    expect([rows[3]?.[8]?.v, rows[3]?.[9]?.v]).toEqual(['u-1', 1])
    expect([rows[4]?.[8]?.v, rows[4]?.[9]?.v]).toEqual([undefined, 0])
  })

  it('refuses a hierarchy plan without the detection, and a subtask that is not under its to-do', () => {
    const wb = blankWorkbook()
    putRow(wb, S, 1, { A: 'أ' })
    putRow(wb, S, 2, { A: 'ب' })
    putRow(wb, S, 3, { A: 'ج' })
    const plan = defaultPlan(S, { hierarchy: { mode: 'numbering', columnKey: 'H' } })
    const missing = ensureSystemColumns(wb.sheets[S] as never, plan, counterUids())
    expect(!missing.ok && missing.error.code).toBe('hierarchy_required')
    expect(!missing.ok && missing.error.message).toMatch(/معالج الربط/)
    const wrongParent = ensureSystemColumns(wb.sheets[S] as never, plan, counterUids(), { levels: [{ row: 3, level: 1, parentRow: 1 }] })
    expect(!wrongParent.ok && wrongParent.error.code).toBe('invalid_hierarchy')
    const orphan = ensureSystemColumns(wb.sheets[S] as never, plan, counterUids(), { levels: [{ row: 1, level: 1, parentRow: null }] })
    expect(!orphan.ok && orphan.error.code).toBe('invalid_hierarchy')
  })

  it('refuses a plan without a title column or with a bad header row', () => {
    const wb = blankWorkbook()
    const noTitle = defaultPlan(S, { columns: [{ columnKey: 'B', field: 'assignees' }] })
    const a = ensureSystemColumns(wb.sheets[S] as never, noTitle, counterUids())
    expect(!a.ok && a.error.code).toBe('title_column_missing')
    const b = ensureSystemColumns(wb.sheets[S] as never, defaultPlan(S, { headerRow: 0 }), counterUids())
    expect(!b.ok && b.error.code).toBe('invalid_header_row')
  })
})

describe('findSystemColumns', () => {
  it('finds the columns by header text, also after columns were inserted before them', () => {
    const wb = blankWorkbook()
    putRow(wb, S, 0, { K: SYSTEM_HEADERS.level, I: SYSTEM_HEADERS.uid, J: SYSTEM_HEADERS.parentUid })
    expect(findSystemColumns(wb.sheets[S] as never, 0)).toEqual({ ok: true, value: { uid: 8, parentUid: 9, level: 10 } })
    expect(findSystemColumns(blankWorkbook().sheets[S] as never, 0)).toEqual({ ok: true, value: null })
  })

  it('refuses a duplicated or incomplete set', () => {
    const wb = blankWorkbook()
    putRow(wb, S, 0, { H: SYSTEM_HEADERS.uid, I: SYSTEM_HEADERS.parentUid, J: SYSTEM_HEADERS.level, K: SYSTEM_HEADERS.uid })
    const dup = findSystemColumns(wb.sheets[S] as never, 0)
    expect(!dup.ok && dup.error.code).toBe('system_columns_duplicated')
    const partial = blankWorkbook()
    putRow(partial, S, 0, { H: SYSTEM_HEADERS.uid })
    const missing = findSystemColumns(partial.sheets[S] as never, 0)
    expect(!missing.ok && missing.error.code).toBe('system_columns_missing')
    expect(cell(partial, S, 0, 'H')?.v).toBe('__uid')
  })
})
