// Plugin resources of a workbook snapshot (`IWorkbookData.resources`): each is
// `{ name, data }` with `data` a JSON string, keyed by sheet id inside.

import type { WorkbookSnapshot } from './cells'
import { RANGE_TYPE, RESOURCE, type IRange, type ISheetDataValidationRule, type UniverSheetNote } from './univer'

export type ParsedResource = { ok: true; value: unknown } | { ok: false }

export function readResource(workbook: WorkbookSnapshot, name: string): ParsedResource | undefined {
  const entry = workbook.resources?.find((r) => r.name === name)
  if (entry === undefined) return undefined
  if (entry.data === '' || entry.data === undefined || entry.data === null) return { ok: true, value: {} }
  try {
    return { ok: true, value: JSON.parse(entry.data) as unknown }
  } catch {
    return { ok: false }
  }
}

/** Replaces a resource's data (mutates). An empty object removes the resource. */
export function writeResource(workbook: WorkbookSnapshot, name: string, value: Record<string, unknown>): void {
  const list = [...(workbook.resources ?? [])]
  const index = list.findIndex((r) => r.name === name)
  const empty = Object.keys(value).length === 0
  if (empty) {
    if (index >= 0) list.splice(index, 1)
  } else if (index >= 0) {
    list[index] = { ...(list[index] as { name: string; data: string }), data: JSON.stringify(value) }
  } else {
    list.push({ name, data: JSON.stringify(value) })
  }
  workbook.resources = list
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function rangeContains(range: IRange, row: number, column: number): boolean {
  const rowsAll = range.rangeType === RANGE_TYPE.COLUMN || range.rangeType === RANGE_TYPE.ALL
  const colsAll = range.rangeType === RANGE_TYPE.ROW || range.rangeType === RANGE_TYPE.ALL
  const inRows = rowsAll || (row >= range.startRow && row <= range.endRow)
  const inCols = colsAll || (column >= range.startColumn && column <= range.endColumn)
  return inRows && inCols
}

/** Data-validation rules of a sheet covering one cell, in stored order. */
export function validationRulesAt(workbook: WorkbookSnapshot, sheetId: string, row: number, column: number): ISheetDataValidationRule[] {
  const parsed = readResource(workbook, RESOURCE.DATA_VALIDATION)
  if (parsed === undefined || !parsed.ok) return []
  const rules = asObject(parsed.value)[sheetId]
  if (!Array.isArray(rules)) return []
  return (rules as ISheetDataValidationRule[]).filter((rule) => (rule.ranges ?? []).some((r) => rangeContains(r, row, column)))
}

// ---------------------------------------------------------------------------
// Notes: { [sheetId]: { [row]: { [col]: ISheetNote } } } (sheets-note toJson)
// ---------------------------------------------------------------------------

export type SheetNotes = Record<string, Record<string, UniverSheetNote>>

export function readNotes(workbook: WorkbookSnapshot, sheetId: string): SheetNotes {
  const parsed = readResource(workbook, RESOURCE.NOTE)
  if (parsed === undefined || !parsed.ok) return {}
  return structuredClone(asObject(asObject(parsed.value)[sheetId])) as SheetNotes
}

export function noteAt(notes: SheetNotes, row: number, column: number): UniverSheetNote | undefined {
  return notes[String(row)]?.[String(column)]
}

/** Writes a sheet's notes back (mutates `workbook`); other sheets' notes are kept. */
export function writeNotes(workbook: WorkbookSnapshot, sheetId: string, notes: SheetNotes): void {
  const parsed = readResource(workbook, RESOURCE.NOTE)
  const all = parsed !== undefined && parsed.ok ? { ...asObject(parsed.value) } : {}
  const clean: SheetNotes = {}
  for (const [row, cols] of Object.entries(notes)) {
    if (Object.keys(cols).length > 0) clean[row] = cols
  }
  if (Object.keys(clean).length > 0) all[sheetId] = clean
  else delete all[sheetId]
  writeResource(workbook, RESOURCE.NOTE, all)
}

export function setNote(notes: SheetNotes, row: number, column: number, note: UniverSheetNote | undefined): void {
  const key = String(row)
  if (note === undefined) {
    const line = notes[key]
    if (line === undefined) return
    delete line[String(column)]
    if (Object.keys(line).length === 0) delete notes[key]
    return
  }
  notes[key] ??= {}
  ;(notes[key] as Record<string, UniverSheetNote>)[String(column)] = { ...note, row, col: column }
}
