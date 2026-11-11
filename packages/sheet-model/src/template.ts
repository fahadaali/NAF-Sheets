// A workbook turned into a template (spec §7.1 option 2: «قوالب يحفظها admin،
// أي ملف يُحوَّل إلى قالب»). A template keeps everything a person made —
// values, formulas, formats, conditional formats, validation, filters, notes,
// column widths — and drops everything that ties rows to Basecamp records:
//
// - the hidden system columns `__uid`, `__parent_uid`, `__level` (spec §6.1):
//   two workbooks made from one template must never share a task identity;
// - the platform's reversible marks (deleted in Basecamp, unsynced subtask
//   cell, subtask indentation), restored to the style the person had set;
// - the platform's own cell data (`custom.nafSheets`) and the platform's
//   «لا يُزامَن مع Basecamp» notes;
// - the dashboard sheet «اللوحة» (@naf-sheets/shared dashboard-sheet.ts): a
//   template holds content only; a workbook made from it gets a new one.
//
// Pure: the input is never mutated. A workbook made from the template starts
// with local sheets only; linking it to Basecamp is the wizard's job (§7.3).

import { withDashboardSheet, withoutDashboardSheet } from '@naf-sheets/shared'
import { cloneWorkbook, getCell, nafData, rowIndexes, setCell, withNafData, type MarkName, type SheetSnapshot, type WorkbookSnapshot } from './cells'
import { removeMark } from './marks'
import { readNotes, writeNotes } from './resources'
import { findSystemColumns } from './system-columns'

/** Prefix of the platform's own notes on unsynced subtask cells (decorate.ts `noteId`). */
const PLATFORM_NOTE_PREFIX = 'naf-unsynced-'

const MARKS: readonly MarkName[] = ['deleted', 'unsynced', 'indent']

export interface TemplateOptions {
  /**
   * 0-based header row of each sheet that has one, by Univer sheet id
   * (D1 `sheets.header_row` − 1). Sheets not listed are searched on row 0.
   */
  headerRows?: Readonly<Record<string, number>>
}

export interface TemplateResult {
  workbook: WorkbookSnapshot
  /** Univer sheet ids whose system columns were removed. */
  strippedSheets: string[]
  /** Sheets whose system columns were incomplete or duplicated: left as they are, for a person to check. */
  unreadableSheets: string[]
}

function clearColumn(sheet: SheetSnapshot, column: number): void {
  for (const row of rowIndexes(sheet)) setCell(sheet, row, column, undefined)
  const data = sheet.columnData as Record<number, Record<string, unknown> | undefined> | undefined
  const entry = data?.[column]
  if (data && entry) {
    const { hd: _hidden, ...rest } = entry
    if (Object.keys(rest).length > 0) data[column] = rest
    else delete data[column]
  }
}

function cleanCells(workbook: WorkbookSnapshot, sheet: SheetSnapshot): void {
  for (const row of rowIndexes(sheet)) {
    const line = (sheet.cellData?.[row] ?? {}) as Record<number, unknown>
    for (const key of Object.keys(line)) {
      const column = Number(key)
      let cell = getCell(sheet, row, column)
      if (cell === undefined || cell === null) continue
      const data = nafData(cell)
      if (Object.keys(data).length === 0) continue
      for (const mark of MARKS) cell = removeMark(workbook, cell, mark)
      cell = withNafData(cell, {})
      setCell(sheet, row, column, Object.keys(cell).length === 0 ? undefined : cell)
    }
  }
}

function dropPlatformNotes(workbook: WorkbookSnapshot, sheetId: string): void {
  const notes = readNotes(workbook, sheetId)
  let changed = false
  for (const [row, cols] of Object.entries(notes)) {
    for (const [col, note] of Object.entries(cols)) {
      if (typeof note?.id === 'string' && note.id.startsWith(PLATFORM_NOTE_PREFIX)) {
        delete cols[col]
        changed = true
      }
    }
    if (Object.keys(cols).length === 0) delete notes[row]
  }
  if (changed) writeNotes(workbook, sheetId, notes)
}

/** The template copy of a workbook snapshot. */
export function toTemplateWorkbook(source: WorkbookSnapshot, options: TemplateOptions = {}): TemplateResult {
  const workbook = cloneWorkbook(withoutDashboardSheet(source))
  const strippedSheets: string[] = []
  const unreadableSheets: string[] = []
  for (const [sheetId, sheet] of Object.entries(workbook.sheets)) {
    if (!sheet) continue
    const headerRow = options.headerRows?.[sheetId] ?? 0
    // Marks first: removing a mark restores the style it replaced, which
    // needs the cell (system cells are dropped afterwards anyway).
    cleanCells(workbook, sheet)
    dropPlatformNotes(workbook, sheetId)
    const system = findSystemColumns(sheet, headerRow)
    if (!system.ok) {
      unreadableSheets.push(sheetId)
      continue
    }
    if (system.value === null) continue
    for (const column of [system.value.uid, system.value.parentUid, system.value.level]) clearColumn(sheet, column)
    strippedSheets.push(sheetId)
  }
  return { workbook, strippedSheets, unreadableSheets }
}

/**
 * A new workbook's snapshot from a template: the same content under the new
 * workbook's id and title, with the dashboard sheet «اللوحة» first (re-created,
 * whatever the template holds). Sheet ids are kept (they only need to be
 * unique inside one workbook, and plugin resources are keyed by them).
 */
export function instantiateTemplate(template: WorkbookSnapshot, input: { workbookId: string; title: string }): WorkbookSnapshot {
  const workbook = cloneWorkbook(withoutDashboardSheet(template))
  workbook.id = input.workbookId
  workbook.name = input.title
  return withDashboardSheet(workbook)
}
