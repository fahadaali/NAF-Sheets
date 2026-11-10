// Where the task data of a synced sheet sits: its header row, the hidden
// system columns (`__uid`, `__parent_uid`, `__level`) and the mapped columns
// (title, assignees, dates, status, notes, attachments).
//
// The mapping is the one committed in the wizard (`SheetMeta.columns`, from
// D1 `column_mappings`; apps/web/OPEN_QUESTIONS.md #33, decided). Only a
// sheet without a stored mapping (an older payload) falls back to inferring
// it from the header texts with the wizard's own rules
// (@naf-sheets/gsheets-import `suggestColumnMapping`).

import { suggestColumnMapping } from '@naf-sheets/gsheets-import'
import { SYSTEM_HEADERS, columnIndex } from '@naf-sheets/sheet-model'
import type { MappedField, SheetMeta, SheetPlan } from '@naf-sheets/shared'
import { columnLetters } from '../lib/cell-target'
import { cellText, type CellReader } from './cells'

export type LayoutField = Exclude<MappedField, 'free'>

export interface SystemColumns {
  uid: number
  parentUid: number
  level: number
}

/** What the editor's sync features need to know about one synced sheet. */
export interface SheetLayout {
  /** Univer sheet id (`SheetMeta.univerSheetId`). */
  sheetId: string
  /** The platform's sheet id (`SheetMeta.id`, `TaskSyncInfo.sheetId`). */
  metaId: string
  /** 0-based header row. Task rows are below it. */
  header: number
  /** Null until the server has added them (linking writes them, sheet-model `ensureSystemColumns`). */
  system: SystemColumns | null
  /** 0-based column of each mapped field found in the header row. */
  fields: Partial<Record<LayoutField, number>>
  /** A plan for calling @naf-sheets/sheet-model on this sheet; `null` without a title column. */
  plan: Pick<SheetPlan, 'sheetId' | 'headerRow' | 'columns' | 'completedValues' | 'assigneeMatches' | 'hierarchy'> | null
}

const SYSTEM_NAMES = Object.keys(SYSTEM_HEADERS) as Array<keyof typeof SYSTEM_HEADERS>

/** The three system columns found by their header text, or null (none, some, or one twice). */
export function findSystemColumns(reader: CellReader, header: number): SystemColumns | null {
  const found: Partial<Record<keyof SystemColumns, number>> = {}
  const last = reader.lastColumn()
  for (let column = 0; column <= last; column++) {
    const text = cellText(reader.cell(header, column)).trim()
    for (const name of SYSTEM_NAMES) {
      if (text !== SYSTEM_HEADERS[name]) continue
      if (found[name] !== undefined) return null
      found[name] = column
    }
  }
  const { uid, parentUid, level } = found
  return uid === undefined || parentUid === undefined || level === undefined ? null : { uid, parentUid, level }
}

/** The layout of `meta`'s sheet; null for a local sheet. */
export function sheetLayout(reader: CellReader, meta: SheetMeta): SheetLayout | null {
  if (meta.syncMode !== 'synced') return null
  const header = Number.isInteger(meta.headerRow) && meta.headerRow >= 1 ? meta.headerRow - 1 : 0
  const system = findSystemColumns(reader, header)
  if (meta.columns && meta.columns.length > 0) return storedLayout(meta, header, system)
  const width = reader.lastColumn() + 1
  const headers = Array.from({ length: Math.max(0, width) }, (_, column) => {
    const text = cellText(reader.cell(header, column))
    // The system columns are never mapped (the wizard skips them the same way).
    return text.trim().startsWith('__') ? '' : text
  })
  const fields: Partial<Record<LayoutField, number>> = {}
  const columns: SheetPlan['columns'] = []
  for (const s of suggestColumnMapping(headers)) {
    if (headers[s.column] === '') continue
    columns.push({ columnKey: columnLetters(s.column), field: s.field })
    if (s.field !== 'free' && fields[s.field] === undefined) fields[s.field] = s.column
  }
  const plan =
    fields.title === undefined
      ? null
      : { sheetId: meta.id, headerRow: header + 1, columns, completedValues: [], assigneeMatches: {}, hierarchy: { mode: 'flat' as const } }
  return { sheetId: meta.univerSheetId, metaId: meta.id, header, system, fields, plan }
}

/** The layout from the mapping committed in the wizard. */
function storedLayout(meta: SheetMeta, header: number, system: SystemColumns | null): SheetLayout {
  const columns = meta.columns ?? []
  const fields: Partial<Record<LayoutField, number>> = {}
  for (const c of columns) {
    if (c.field === 'free') continue
    const column = columnIndex(c.columnKey)
    if (column !== null && fields[c.field] === undefined) fields[c.field] = column
  }
  const plan =
    fields.title === undefined
      ? null
      : { sheetId: meta.id, headerRow: header + 1, columns, completedValues: meta.completedValues ?? [], assigneeMatches: {}, hierarchy: { mode: 'flat' as const } }
  return { sheetId: meta.univerSheetId, metaId: meta.id, header, system, fields, plan }
}

export function systemColumnSet(system: SystemColumns): number[] {
  return [system.uid, system.parentUid, system.level].sort((a, b) => a - b)
}
