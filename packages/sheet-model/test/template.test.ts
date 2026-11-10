// Templates (spec §7.1 option 2): a workbook turned into a template keeps what
// a person made and loses every tie to Basecamp records.

import { describe, expect, it } from 'vitest'
import { decorateTaskRows, instantiateTemplate, readTasks, toTemplateWorkbook, type DecorationOptions, type WorkbookSnapshot } from '../src'
import { blankWorkbook, cell, defaultPlan, linkedWorkbook, putRow } from './helpers'

const S = 'sheet-1'
const decoration: DecorationOptions = { unsyncedStyle: { bg: { rgb: 'theme-unsynced' } }, subtaskIndent: 18 }

function notes(workbook: WorkbookSnapshot): Record<string, Record<string, { id: string; note: string }>> {
  const entry = workbook.resources?.find((r) => r.name === 'SHEET_NOTE_PLUGIN')
  return entry ? ((JSON.parse(entry.data) as Record<string, never>)[S] ?? {}) : {}
}

function headerTexts(workbook: WorkbookSnapshot): string[] {
  const line = (workbook.sheets[S]?.cellData?.[0] ?? {}) as Record<number, { v?: unknown }>
  return Object.keys(line)
    .map(Number)
    .sort((a, b) => a - b)
    .map((c) => String(line[c]?.v ?? ''))
}

describe('toTemplateWorkbook', () => {
  it('keeps a blank workbook as it is: the default columns stay', () => {
    const source = blankWorkbook()
    const { workbook, strippedSheets, unreadableSheets } = toTemplateWorkbook(source)
    expect(workbook).toEqual(source)
    expect(headerTexts(workbook)).toEqual(['المهمة', 'المسؤول', 'تاريخ البدء', 'تاريخ الاستحقاق', 'الحالة', 'المرفقات', 'ملاحظات'])
    expect(strippedSheets).toEqual([])
    expect(unreadableSheets).toEqual([])
  })

  it('removes the system columns of a synced sheet, values and hidden flags, and never mutates the source', () => {
    const { workbook: source } = linkedWorkbook(['حملة', 'تصميم'])
    const before = JSON.stringify(source)
    expect(headerTexts(source)).toContain('__uid')
    const { workbook, strippedSheets } = toTemplateWorkbook(source)
    expect(JSON.stringify(source)).toBe(before)
    expect(strippedSheets).toEqual([S])
    expect(headerTexts(workbook)).toEqual(['المهمة', 'المسؤول', 'تاريخ البدء', 'تاريخ الاستحقاق', 'الحالة', 'المرفقات', 'ملاحظات'])
    // Values a person typed stay; no cell holds a task uid any more.
    expect(cell(workbook, S, 1, 'A')?.v).toBe('حملة')
    expect(JSON.stringify(workbook.sheets[S]?.cellData)).not.toMatch(/"u-\d+"/)
    const hidden = Object.values((workbook.sheets[S]?.columnData ?? {}) as Record<string, { hd?: number }>).filter((c) => c.hd === 1)
    expect(hidden).toEqual([])
    // Nothing reads as a task row: a template is not linked.
    const read = readTasks(workbook, S, defaultPlan(S))
    expect(read.ok).toBe(false)
  })

  it('restores the styles under the platform marks and drops the platform notes, keeping a person’s note', () => {
    const { workbook: linked } = linkedWorkbook(['حملة', 'تصميم'], { levels: [{ row: 2, level: 1, parentRow: 1 }] })
    linked.resources = [{ name: 'SHEET_NOTE_PLUGIN', data: JSON.stringify({ [S]: { 1: { 6: { id: 'mine', row: 1, col: 6, width: 160, height: 72, note: 'ملاحظتي' } } } }) }]
    const decorated = decorateTaskRows(linked, S, defaultPlan(S), decoration)
    if (!decorated.ok) throw new Error(decorated.error.message)
    const source = decorated.value.workbook
    expect(Object.keys(notes(source)['2'] ?? {}).length).toBeGreaterThan(0)

    const { workbook } = toTemplateWorkbook(source)
    expect(notes(workbook)).toEqual({ 1: { 6: expect.objectContaining({ id: 'mine', note: 'ملاحظتي' }) } })
    expect(JSON.stringify(workbook)).not.toContain('nafSheets')
    expect(JSON.stringify(workbook)).not.toContain('theme-unsynced')
    // The subtask's title keeps its text; the platform's indentation is gone.
    expect(cell(workbook, S, 2, 'A')?.v).toBe('تصميم')
    expect(JSON.stringify(cell(workbook, S, 2, 'A') ?? {})).not.toContain('"pd"')
  })

  it('leaves a sheet with broken system columns as it is and reports it', () => {
    const source = blankWorkbook()
    putRow(source, S, 0, { H: '__uid' })
    const { workbook, unreadableSheets, strippedSheets } = toTemplateWorkbook(source)
    expect(unreadableSheets).toEqual([S])
    expect(strippedSheets).toEqual([])
    expect(cell(workbook, S, 0, 'H')?.v).toBe('__uid')
  })

  it('looks for the system columns on the header row it is given', () => {
    const { workbook: source } = linkedWorkbook(['حملة'])
    // Move everything down one row: the header is now row 1.
    const data = source.sheets[S]!.cellData as Record<number, unknown>
    const moved: Record<number, unknown> = {}
    for (const [row, line] of Object.entries(data)) moved[Number(row) + 1] = line
    source.sheets[S]!.cellData = moved as never
    expect(toTemplateWorkbook(source).strippedSheets).toEqual([])
    expect(toTemplateWorkbook(source, { headerRows: { [S]: 1 } }).strippedSheets).toEqual([S])
  })
})

describe('instantiateTemplate', () => {
  it('gives the copy the new workbook id and title, keeps the sheets and never mutates the template', () => {
    const template = blankWorkbook([
      { id: 'a', title: 'المهام' },
      { id: 'b', title: 'الميزانية' },
    ])
    const before = JSON.stringify(template)
    const copy = instantiateTemplate(template, { workbookId: 'wb-new', title: 'حملة الربع الأول' })
    expect(copy.id).toBe('wb-new')
    expect(copy.name).toBe('حملة الربع الأول')
    expect(copy.sheetOrder).toEqual(['a', 'b'])
    expect(JSON.stringify(template)).toBe(before)
  })
})
