// Reading and writing the mapped fields of a task row (spec §7.3 step 4, §8
// table): title, assignees, dates, completion, notes, free columns.

import type { Assignee, IsoDate, MappedField, SheetPlan } from '@naf-sheets/shared'
import { columnIndex } from './a1'
import { cellText, getCell, hasFormula, isTruthyBoolean, nafData, ownStyle, sameJson, setCell, withNafData, type SheetSnapshot, type WorkbookSnapshot } from './cells'
import { ISO_DATE_PATTERN, isoToSerial, readDateValue, type DateRead } from './dates'
import { escapeHtml, htmlToComparableText } from './engine'
import { fail, ok, type Result } from './errors'
import { validationRulesAt } from './resources'
import { CELL_TYPE, CHECKBOX_DEFAULT, DV_TYPE, type ICellData, type IStyleData } from './univer'

// ---------------------------------------------------------------------------
// Columns of a plan
// ---------------------------------------------------------------------------

export type SingleField = Exclude<MappedField, 'free'>

export interface FieldColumns {
  /** 0-based column of each mapped field (the first mapping when a field appears twice). */
  field: Partial<Record<SingleField, number>>
  title: number
  free: Array<{ column: number; appendToDescription: boolean }>
}

export function fieldColumns(plan: Pick<SheetPlan, 'columns'>): Result<FieldColumns> {
  const field: Partial<Record<SingleField, number>> = {}
  const free: FieldColumns['free'] = []
  for (const mapping of plan.columns) {
    const column = columnIndex(mapping.columnKey)
    if (column === null) return fail('invalid_column_key', mapping.columnKey)
    if (mapping.field === 'free') free.push({ column, appendToDescription: mapping.appendToDescription === true })
    else if (field[mapping.field] === undefined) field[mapping.field] = column
  }
  if (field.title === undefined) return fail('title_column_missing')
  return ok({ field, title: field.title, free })
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** People and external contacts by name, for the assignee column (spec §8.2, §9.5). */
export interface AssigneeDirectory {
  /** Basecamp people (bc_people_cache): project members, and account members when known. */
  people: ReadonlyArray<{ id: number; name: string }>
  /** External contacts (spec §8.2 case 3). */
  externals: ReadonlyArray<{ id: string; name: string }>
}

/**
 * Name comparison: Unicode NFC, bidi and zero-width controls removed,
 * whitespace collapsed, Latin case folded. Arabic letter forms are not folded.
 * OPEN: OPEN_QUESTIONS.md #6.
 */
export function normalizeName(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export function assigneeName(assignee: Assignee, directory: AssigneeDirectory | undefined): string | null {
  if (directory === undefined) return null
  if (assignee.kind === 'external') return directory.externals.find((e) => e.id === assignee.externalContactId)?.name ?? null
  return directory.people.find((p) => p.id === assignee.bcPersonId)?.name ?? null
}

/**
 * Names in an assignee cell. Univer's multiple-choice list stores a JSON array
 * (`serializeListOptions`) and otherwise splits on commas
 * (`deserializeListOptions`); the Arabic comma and line breaks also separate
 * names here. OPEN: OPEN_QUESTIONS.md #6.
 */
export function splitAssigneeText(text: string): string[] {
  const t = text.trim()
  if (t === '') return []
  let parts: string[] | null = null
  if (t.startsWith('[')) {
    try {
      const parsed = JSON.parse(t) as unknown
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) parts = parsed as string[]
    } catch {
      parts = null
    }
  }
  parts ??= t.split(/[,،\n]/)
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of parts) {
    const name = raw.trim()
    const key = normalizeName(name)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out
}

export type AssigneeResolution =
  | { kind: 'assignee'; assignee: Assignee }
  /** `plan.assigneeMatches` maps the text to null: left unassigned on purpose (spec §7.3 step 7). */
  | { kind: 'skipped' }
  | { kind: 'unknown' }
  | { kind: 'ambiguous' }

/**
 * One name of an assignee cell. In order: an assignee the row already had
 * with that name (keeps follower / automatic / e-mail settings), the
 * wizard's confirmed matches, then exactly one person or one external contact
 * with that name.
 */
export function resolveAssignee(
  name: string,
  plan: Pick<SheetPlan, 'assigneeMatches'>,
  directory: AssigneeDirectory | undefined,
  known: readonly Assignee[],
): AssigneeResolution {
  const key = normalizeName(name)
  const knownMatch = known.filter((a) => {
    const n = assigneeName(a, directory)
    return n !== null && normalizeName(n) === key
  })
  if (knownMatch.length === 1) return { kind: 'assignee', assignee: knownMatch[0] as Assignee }
  for (const [text, id] of Object.entries(plan.assigneeMatches ?? {})) {
    if (normalizeName(text) !== key) continue
    return id === null ? { kind: 'skipped' } : { kind: 'assignee', assignee: { kind: 'bc_person', bcPersonId: id, source: 'manual' } }
  }
  const people = directory?.people.filter((p) => normalizeName(p.name) === key) ?? []
  const externals = directory?.externals.filter((e) => normalizeName(e.name) === key) ?? []
  if (people.length + externals.length > 1 || knownMatch.length > 1) return { kind: 'ambiguous' }
  const person = people[0]
  if (person !== undefined) return { kind: 'assignee', assignee: { kind: 'bc_person', bcPersonId: person.id, source: 'manual' } }
  const external = externals[0]
  // OPEN: e-mail for an external typed into the cell is off until a person turns it on (OPEN_QUESTIONS.md #7).
  if (external !== undefined) return { kind: 'assignee', assignee: { kind: 'external', externalContactId: external.id, source: 'manual', notifyEmail: false } }
  return { kind: 'unknown' }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export function readDateCell(cell: ICellData | undefined, dateSystem: unknown): DateRead {
  if (cell === undefined) return { kind: 'empty' }
  if (cell.p?.body?.dataStream) return readDateValue(cellText(cell), dateSystem)
  if (typeof cell.v === 'string' && (cell.t === CELL_TYPE.NUMBER || cell.t === undefined) && /^\s*-?\d+(\.\d+)?\s*$/.test(cell.v)) {
    // A number stored as text by an older writer: still a serial.
    return readDateValue(Number(cell.v), dateSystem)
  }
  return readDateValue(cell.v, dateSystem)
}

/** sheets-data-validation `transformCheckboxValue`: TRUE / FALSE compare as 1 / 0. */
function checkboxValue(value: unknown): string {
  const s = String(value ?? '')
  const lower = s.toLowerCase()
  return lower === 'true' ? '1' : lower === 'false' ? '0' : s
}

function isFormulaText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().startsWith('=')
}

export type CompletedRead = { kind: 'value'; completed: boolean } | { kind: 'checkbox_formula' }

/**
 * Completion of a row (spec §5.2, §7.3 step 6):
 * - a checkbox (data validation) is ticked when the cell holds its checked value;
 * - otherwise, with `completedValues`, the status text is one of them;
 * - otherwise a boolean cell that is TRUE.
 */
export function readCompleted(
  workbook: WorkbookSnapshot,
  sheetId: string,
  row: number,
  column: number,
  plan: Pick<SheetPlan, 'completedValues'>,
): CompletedRead {
  const cell = getCell(workbook.sheets[sheetId] ?? {}, row, column)
  const checkbox = validationRulesAt(workbook, sheetId, row, column).find((r) => r.type === DV_TYPE.CHECKBOX)
  if (checkbox !== undefined) {
    const checked = checkbox.formula1 ?? CHECKBOX_DEFAULT.checked
    if (isFormulaText(checked)) return { kind: 'checkbox_formula' }
    return { kind: 'value', completed: cell?.v !== undefined && cell?.v !== null && checkboxValue(cell.v) === checkboxValue(checked) }
  }
  const values = plan.completedValues ?? []
  if (values.length > 0) {
    // OPEN: compared like names, not with the wizard's label folding (OPEN_QUESTIONS.md #19).
    const text = normalizeName(cellText(cell))
    return { kind: 'value', completed: text !== '' && values.some((v) => normalizeName(v) === text) }
  }
  const isBoolean = cell?.t === CELL_TYPE.BOOLEAN || typeof cell?.v === 'boolean'
  return { kind: 'value', completed: isBoolean && isTruthyBoolean(cell?.v) }
}

/** Lines of plain text as `htmlToComparableText` produces them. */
export function comparableText(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n')
}

/** Plain text a person typed → description HTML. OPEN: the markup Basecamp expects (OPEN_QUESTIONS.md #8). */
export function textToHtml(text: string): string {
  const lines = comparableText(text).split('\n')
  return `<div>${lines.map(escapeHtml).join('<br>')}</div>`
}

/**
 * The notes cell as description HTML. When the text is still what was
 * rendered from Basecamp's HTML (kept in the cell's platform data), that HTML
 * is returned unchanged: formatting and attachments survive a round trip.
 */
export function readNotes(cell: ICellData | undefined): string | null {
  const text = cellText(cell)
  if (comparableText(text) === '') return null
  const stored = nafData(cell).notesHtml
  if (stored !== undefined && comparableText(text) === htmlToComparableText(stored)) return stored
  return textToHtml(text)
}

// ---------------------------------------------------------------------------
// Writing (inbound): only the mapped cells of a row, never over a formula
// ---------------------------------------------------------------------------

export type WriteOutcome = 'written' | 'unchanged' | 'formula_cell'

/** Replaces the value of a cell, keeping its style and platform data. `null` clears the value. */
export function writeValue(
  sheet: SheetSnapshot,
  row: number,
  column: number,
  value: { v: string | number; t: (typeof CELL_TYPE)[keyof typeof CELL_TYPE] } | null,
  adjust?: (cell: ICellData) => ICellData,
): WriteOutcome {
  const current = getCell(sheet, row, column)
  if (hasFormula(current)) return 'formula_cell'
  let next: ICellData = { ...(current ?? {}) }
  delete next.p
  delete next.f
  delete next.si
  if (value === null) {
    delete next.v
    delete next.t
  } else {
    next.v = value.v
    next.t = value.t
  }
  if (adjust !== undefined) next = adjust(next)
  if (current !== undefined && sameJson(current, next)) return 'unchanged'
  setCell(sheet, row, column, Object.keys(next).length > 0 ? next : undefined)
  return 'written'
}

/** Assignee names as the cell shows them; Univer's JSON list when the cell has a multiple-choice list. */
export function formatAssignees(names: readonly string[], multipleList: boolean): string {
  if (names.length === 0) return ''
  // OPEN: separator outside a multiple-choice list (OPEN_QUESTIONS.md #6).
  return multipleList ? JSON.stringify(names) : names.join('، ')
}

export function isMultipleList(workbook: WorkbookSnapshot, sheetId: string, row: number, column: number): boolean {
  return validationRulesAt(workbook, sheetId, row, column).some((r) => r.type === DV_TYPE.LIST_MULTIPLE)
}

/** The value a date takes in a cell: a serial with a date format, or `YYYY-MM-DD` text where the cell holds text. */
export function writeDate(
  workbook: WorkbookSnapshot,
  sheet: SheetSnapshot,
  row: number,
  column: number,
  date: IsoDate | null,
): WriteOutcome {
  if (date === null) return writeValue(sheet, row, column, null)
  const current = getCell(sheet, row, column)
  const serial = isoToSerial(date, workbook.dateSystem)
  if (serial === null || (typeof current?.v === 'string' && current.v.trim() !== '')) {
    return writeValue(sheet, row, column, { v: date, t: CELL_TYPE.STRING })
  }
  return writeValue(sheet, row, column, { v: serial, t: CELL_TYPE.NUMBER }, (cell) => {
    const style = ownStyle(workbook, cell)
    const columnStyle = sheet.columnData?.[column]?.s
    const rowStyle = sheet.rowData?.[row]?.s
    const formatted = (s: unknown): boolean => {
      const resolved = typeof s === 'string' ? workbook.styles?.[s] : (s as IStyleData | null | undefined)
      return Boolean(resolved?.n?.pattern)
    }
    if (style.n?.pattern || formatted(columnStyle) || formatted(rowStyle)) return cell
    return { ...cell, s: { ...style, n: { pattern: ISO_DATE_PATTERN } } }
  })
}

export type CompletedWrite = WriteOutcome | 'checkbox_formula'

/**
 * Writes completion the way the column holds it: the checkbox's own values,
 * one of `completedValues`, or a boolean. Un-completing a status column whose
 * text is a "completed" value clears the cell (OPEN: OPEN_QUESTIONS.md #9);
 * any other status text is left as it is.
 */
export function writeCompleted(
  workbook: WorkbookSnapshot,
  sheetId: string,
  row: number,
  column: number,
  plan: Pick<SheetPlan, 'completedValues'>,
  completed: boolean,
): CompletedWrite {
  const sheet = workbook.sheets[sheetId] as SheetSnapshot
  const now = readCompleted(workbook, sheetId, row, column, plan)
  if (now.kind === 'checkbox_formula') return 'checkbox_formula'
  if (now.completed === completed) return 'unchanged'
  const checkbox = validationRulesAt(workbook, sheetId, row, column).find((r) => r.type === DV_TYPE.CHECKBOX)
  const current = getCell(sheet, row, column)
  if (checkbox !== undefined) {
    const raw = completed ? (checkbox.formula1 ?? CHECKBOX_DEFAULT.checked) : (checkbox.formula2 ?? CHECKBOX_DEFAULT.unchecked)
    if (current?.t === CELL_TYPE.BOOLEAN && (checkboxValue(raw) === '1' || checkboxValue(raw) === '0')) {
      return writeValue(sheet, row, column, { v: Number(checkboxValue(raw)), t: CELL_TYPE.BOOLEAN })
    }
    return typeof raw === 'number'
      ? writeValue(sheet, row, column, { v: raw, t: CELL_TYPE.NUMBER })
      : writeValue(sheet, row, column, { v: String(raw), t: CELL_TYPE.STRING })
  }
  const values = plan.completedValues ?? []
  if (values.length > 0) {
    if (completed) return writeValue(sheet, row, column, { v: values[0] as string, t: CELL_TYPE.STRING })
    return writeValue(sheet, row, column, null)
  }
  return writeValue(sheet, row, column, { v: completed ? 1 : 0, t: CELL_TYPE.BOOLEAN })
}

/** Notes: the text rendered from the HTML, with the HTML kept in the cell's platform data. */
export function writeNotes(sheet: SheetSnapshot, row: number, column: number, html: string | null): WriteOutcome {
  const current = getCell(sheet, row, column)
  if (html === null || htmlToComparableText(html) === '') {
    return writeValue(sheet, row, column, null, (cell) => {
      const data = nafData(cell)
      delete data.notesHtml
      return withNafData(cell, data)
    })
  }
  // Already showing this HTML (or text that reads the same, and the HTML is kept): leave it.
  if (current !== undefined && readNotes(current) === html) return 'unchanged'
  const text = htmlToComparableText(html)
  return writeValue(sheet, row, column, { v: text, t: CELL_TYPE.STRING }, (cell) => withNafData(cell, { ...nafData(cell), notesHtml: html }))
}
