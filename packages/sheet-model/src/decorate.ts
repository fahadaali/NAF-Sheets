// What a row shows beyond its values: struck through and grey when deleted in
// Basecamp (§9.3.10), the start indentation of a subtask's title, and the
// marking of a subtask's cells that Basecamp has no field for (§8 note).

import type { TaskLevel, TaskUid } from '@naf-sheets/shared'
import { getCell, isBlankCell, nafData, ownStyle, rowCells, setCell, withNafData, type SheetSnapshot, type WorkbookSnapshot } from './cells'
import { issue, type SheetIssue } from './errors'
import type { SingleField } from './fields'
import { applyMark, removeMark } from './marks'
import { noteAt, readNotes, setNote, writeNotes } from './resources'
import type { SystemColumns } from './system-columns'
import type { TaskTable } from './table'
import { DEFAULT_NOTE_SIZE, type IStyleData } from './univer'

/** The note on a subtask cell that Basecamp does not sync (spec §8 note). */
export const UNSYNCED_NOTE = 'لا يُزامَن مع Basecamp'

/**
 * Fields a subtask has no counterpart for in Basecamp (spec §8 table).
 * OPEN: free columns appended to the description are not marked (OPEN_QUESTIONS.md #15).
 */
export const UNSYNCED_SUBTASK_FIELDS: readonly SingleField[] = ['starts_on', 'notes', 'attachments']

export interface DecorationOptions {
  /**
   * Style of a subtask cell that does not sync (the light background of the
   * §8 note). From the platform's theme. Not marked when absent.
   * OPEN: Univer styles have no hatch pattern (OPEN_QUESTIONS.md #14).
   */
  unsyncedStyle?: IStyleData
  /**
   * Start padding, in pixels, of a subtask's title (`pd.l`: the start side on
   * the mirrored grid). Not indented when absent. OPEN: OPEN_QUESTIONS.md #13.
   */
  subtaskIndent?: number
}

function systemColumnSet(system: SystemColumns): Set<number> {
  return new Set([system.uid, system.parentUid, system.level])
}

function update(sheet: SheetSnapshot, row: number, column: number, next: ReturnType<typeof getCell>): void {
  const empty = next === undefined || Object.keys(next).length === 0
  setCell(sheet, row, column, empty ? undefined : next)
}

/** Strikes through and greys every user cell of a row, and records the Basecamp status on its uid cell. */
export function markDeleted(
  workbook: WorkbookSnapshot,
  table: TaskTable,
  row: number,
  status: 'archived' | 'trashed' | 'deleted',
  style: IStyleData,
): void {
  const sheet = table.sheet
  const system = systemColumnSet(table.system)
  for (const [key, cell] of Object.entries(rowCells(sheet, row))) {
    const column = Number(key)
    if (system.has(column) || isBlankCell(cell)) continue
    update(sheet, row, column, applyMark(workbook, cell, 'deleted', style))
  }
  const uidCell = getCell(sheet, row, table.system.uid) ?? {}
  update(sheet, row, table.system.uid, withNafData(uidCell, { ...nafData(uidCell), deletedRemotely: status }))
}

export function unmarkDeleted(workbook: WorkbookSnapshot, table: TaskTable, row: number): void {
  const sheet = table.sheet
  for (const [key, cell] of Object.entries(rowCells(sheet, row))) {
    update(sheet, row, Number(key), removeMark(workbook, cell, 'deleted'))
  }
  const uidCell = getCell(sheet, row, table.system.uid)
  if (uidCell !== undefined) {
    const data = nafData(uidCell)
    delete data.deletedRemotely
    update(sheet, row, table.system.uid, withNafData(uidCell, data))
  }
}

function noteId(uid: TaskUid, field: SingleField): string {
  return `naf-unsynced-${uid}-${field}`
}

/**
 * Level-dependent marks of one row: the title's start indentation and the
 * unsynced cells of a subtask, added for level 1 and removed for level 0.
 * Mutates `workbook`; issues go to `issues`.
 */
export function decorateRow(
  workbook: WorkbookSnapshot,
  table: TaskTable,
  row: number,
  uid: TaskUid,
  level: TaskLevel,
  options: DecorationOptions,
  issues: SheetIssue[],
): void {
  const sheet = table.sheet
  const title = table.fields.title
  const titleCell = getCell(sheet, row, title)
  if (level === 1 && options.subtaskIndent !== undefined) {
    const base = removeMark(workbook, titleCell ?? {}, 'indent')
    const pd = ownStyle(workbook, base).pd ?? {}
    update(sheet, row, title, applyMark(workbook, base, 'indent', { pd: { ...pd, l: options.subtaskIndent } }))
  } else if (level === 0 && titleCell !== undefined) {
    update(sheet, row, title, removeMark(workbook, titleCell, 'indent'))
  }

  const notes = readNotes(workbook, table.sheetId)
  let notesChanged = false
  for (const field of UNSYNCED_SUBTASK_FIELDS) {
    const column = table.fields.field[field]
    if (column === undefined) continue
    const cell = getCell(sheet, row, column)
    const note = noteAt(notes, row, column)
    const ours = note !== undefined && note.id === noteId(uid, field) && note.note === UNSYNCED_NOTE
    if (level === 1 && options.unsyncedStyle !== undefined) {
      update(sheet, row, column, applyMark(workbook, cell ?? {}, 'unsynced', options.unsyncedStyle))
      if (note === undefined) {
        setNote(notes, row, column, { id: noteId(uid, field), row, col: column, ...DEFAULT_NOTE_SIZE, note: UNSYNCED_NOTE })
        notesChanged = true
      } else if (!ours) {
        issues.push(issue('note_occupied', { sheetId: table.sheetId, row, column, uid }))
      }
    } else if (level === 0) {
      if (cell !== undefined) update(sheet, row, column, removeMark(workbook, cell, 'unsynced'))
      if (ours) {
        setNote(notes, row, column, undefined)
        notesChanged = true
      }
    }
  }
  if (notesChanged) writeNotes(workbook, table.sheetId, notes)
}
