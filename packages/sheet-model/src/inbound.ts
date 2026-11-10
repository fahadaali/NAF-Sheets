// Applying the sync engine's inbound actions (spec §9.3) to a stored snapshot.
//
// The input workbook is never changed; the result is a new workbook. Actions
// apply in order, each on its own: a refused action changes nothing and the
// next one still runs (a subtask whose to-do was refused is then refused too,
// for want of its parent).

import type { Assignee, InboundAction, LocalTask, SheetPlan, TaskUid } from '@naf-sheets/shared'
import { columnLetters } from './a1'
import { cellText, getCell, hasFormula, isBlankCell, rowCells, setCell, type WorkbookSnapshot } from './cells'
import { changedCells, changedResources, editable, type CellRef } from './changes'
import { decorateRow, markDeleted, unmarkDeleted, UNSYNCED_NOTE, type DecorationOptions } from './decorate'
import { fail, issue, ok, type Result, type SheetError, type SheetIssue } from './errors'
import {
  assigneeName,
  formatAssignees,
  isMultipleList,
  normalizeName,
  readCompleted,
  writeCompleted,
  writeDate,
  writeNotes,
  writeValue,
  type AssigneeDirectory,
  type WriteOutcome,
} from './fields'
import { readNotes, setNote, writeNotes as writeSheetNotes } from './resources'
import { writeSystemCells, type SystemRow } from './system-columns'
import { applyOrder, freeRowsBelow, openTable, orderRowsOf, placeAt, type OrderRow, type TaskTable } from './table'
import { CELL_TYPE, type IStyleData } from './univer'

/** Name of the sheet that receives to-dos moved to a list no sheet is linked to (spec §9.3.11). */
export const UNCLASSIFIED_SHEET_NAME = 'غير مصنّف'

export interface ApplyInboundOptions extends DecorationOptions {
  /** Names for the assignee column. Without it, assignee updates are not written (issue `assignee_name_unknown`). */
  directory?: AssigneeDirectory
  /** Style of a row deleted in Basecamp (strikethrough and grey from the theme, spec §9.3.10). */
  deletedStyle: IStyleData
  /** The sheet linked to a Basecamp list (its Univer id and plan): where `move_row` sends a to-do. */
  sheetForList?: (listId: number) => { univerSheetId: string; plan: SheetPlan } | null
  /**
   * The «غير مصنّف» sheet for to-dos moved to an unlinked list. Created with
   * `univerSheetId` when the workbook has no sheet with that id (its plan, with
   * `sheetId` as the platform's id, is then in `createdSheets`); an existing
   * one needs its `plan`.
   */
  unclassified?: { univerSheetId: string; sheetId: string; plan?: SheetPlan }
}

export type ActionStatus = 'applied' | 'ignored' | 'refused'

export interface ActionOutcome {
  index: number
  type: InboundAction['type']
  uid: TaskUid
  status: ActionStatus
  error?: SheetError
}

export interface ApplyInboundResult {
  workbook: WorkbookSnapshot
  outcomes: ActionOutcome[]
  /** Cells left as they were (a formula, an unknown name…), and notes that could not be added. */
  issues: SheetIssue[]
  /** Cells whose stored content changed, in every sheet. */
  changedCells: CellRef[]
  /** Plugin resources that changed (notes, validation ranges…). */
  changedResources: string[]
  /** Sheets created by this call (the «غير مصنّف» sheet), with the plan to store for them. */
  createdSheets: Array<{ univerSheetId: string; name: string; plan: SheetPlan }>
}

type Plan = SheetPlan

interface Ctx {
  sheetId: string
  plan: Plan
  options: ApplyInboundOptions
  issues: SheetIssue[]
  created: ApplyInboundResult['createdSheets']
}

function report(ctx: Ctx, outcome: WriteOutcome | 'checkbox_formula', sheetId: string, row: number, column: number, uid: TaskUid): void {
  if (outcome === 'formula_cell') ctx.issues.push(issue('formula_cell', { sheetId, row, column, uid }))
  if (outcome === 'checkbox_formula') ctx.issues.push(issue('checkbox_formula', { sheetId, row, column, uid }))
}

type TaskFields = Partial<Pick<LocalTask, 'title' | 'assignees' | 'dueOn' | 'startsOn' | 'completed' | 'notesHtml'>>

/** Writes the mapped fields given in `fields` into one row. */
function writeFields(workbook: WorkbookSnapshot, table: TaskTable, plan: Plan, row: number, uid: TaskUid, fields: TaskFields, ctx: Ctx): void {
  const sheet = table.sheet
  const f = table.fields.field
  const at = (column: number, outcome: WriteOutcome | 'checkbox_formula'): void => report(ctx, outcome, table.sheetId, row, column, uid)
  if (fields.title !== undefined) at(table.fields.title, writeValue(sheet, row, table.fields.title, { v: fields.title, t: CELL_TYPE.STRING }))
  if (fields.assignees !== undefined && f.assignees !== undefined) writeAssignees(workbook, table, row, f.assignees, uid, fields.assignees, ctx)
  if (fields.dueOn !== undefined && f.due_on !== undefined) at(f.due_on, writeDate(workbook, sheet, row, f.due_on, fields.dueOn))
  if (fields.startsOn !== undefined && f.starts_on !== undefined) at(f.starts_on, writeDate(workbook, sheet, row, f.starts_on, fields.startsOn))
  if (fields.completed !== undefined && f.completed !== undefined) at(f.completed, writeCompleted(workbook, table.sheetId, row, f.completed, plan, fields.completed))
  if (fields.notesHtml !== undefined && f.notes !== undefined) at(f.notes, writeNotes(sheet, row, f.notes, fields.notesHtml))
}

function writeAssignees(workbook: WorkbookSnapshot, table: TaskTable, row: number, column: number, uid: TaskUid, assignees: readonly Assignee[], ctx: Ctx): void {
  const names: string[] = []
  for (const a of assignees) {
    const name = assigneeName(a, ctx.options.directory)
    if (name === null) {
      ctx.issues.push(issue('assignee_name_unknown', { sheetId: table.sheetId, row, column, uid, detail: a.kind === 'external' ? a.externalContactId : String(a.bcPersonId) }))
      return
    }
    if (!names.some((n) => normalizeName(n) === normalizeName(name))) names.push(name)
  }
  const text = formatAssignees(names, isMultipleList(workbook, table.sheetId, row, column))
  const outcome = writeValue(table.sheet, row, column, text === '' ? null : { v: text, t: CELL_TYPE.STRING })
  report(ctx, outcome, table.sheetId, row, column, uid)
}

function rowOf(table: TaskTable, uid: TaskUid): SystemRow | undefined {
  return table.rows.find((r) => r.uid === uid)
}

/** Reorders the table so `uid` is at `position` among its siblings (`null`: last). */
function reposition(workbook: WorkbookSnapshot, sheetId: string, plan: Plan, uid: TaskUid, position: number | null): Result<void> {
  const table = openTable(workbook, sheetId, plan)
  if (!table.ok) return table
  const rows = orderRowsOf(table.value)
  const placed = placeAt(rows, uid, position)
  if (!placed.ok) return placed
  const done = applyOrder(workbook, sheetId, placed.value, rows.map((r) => r.row))
  return done.ok ? ok(undefined) : done
}

function redecorate(workbook: WorkbookSnapshot, sheetId: string, plan: Plan, uids: readonly TaskUid[], ctx: Ctx): Result<void> {
  if (ctx.options.unsyncedStyle === undefined && ctx.options.subtaskIndent === undefined) return ok(undefined)
  const table = openTable(workbook, sheetId, plan)
  if (!table.ok) return table
  for (const uid of uids) {
    const row = rowOf(table.value, uid)
    if (row !== undefined) decorateRow(workbook, table.value, row.row, uid, row.level, ctx.options, ctx.issues)
  }
  return ok(undefined)
}

function createRow(workbook: WorkbookSnapshot, action: Extract<InboundAction, { type: 'create_row' }>, ctx: Ctx): Result<void> {
  const task = action.task
  if (task.sheetId !== ctx.plan.sheetId) return fail('sheet_not_found', `task.sheetId ${task.sheetId}`)
  if (task.title.trim() === '') return fail('title_required')
  const table = openTable(workbook, ctx.sheetId, ctx.plan)
  if (!table.ok) return table
  const t = table.value
  const uidTaken = t.rows.some((r) => r.uid === task.uid) || t.issues.some((i) => i.uid === task.uid)
  if (uidTaken) return fail('uid_exists')
  if (task.level === 1) {
    const parent = rowOf(t, task.parentUid ?? '')
    if (parent === undefined || parent.level !== 0) return fail('parent_not_found')
  }
  const free = freeRowsBelow(workbook, t, 1)
  if (!free.ok) return free
  const row = free.value[0] as number
  writeSystemCells(t.sheet, row, t.system, { uid: task.uid, parentUid: task.level === 1 ? task.parentUid : null, level: task.level })
  writeFields(workbook, t, ctx.plan, row, task.uid, task, ctx)
  const rows: OrderRow[] = [...orderRowsOf(t), { uid: task.uid, parentUid: task.level === 1 ? task.parentUid : null, level: task.level, position: 0, row }]
  const placed = placeAt(rows, task.uid, task.position)
  if (!placed.ok) return placed
  const done = applyOrder(workbook, ctx.sheetId, placed.value, rows.map((r) => r.row))
  if (!done.ok) return done
  return redecorate(workbook, ctx.sheetId, ctx.plan, [task.uid], ctx)
}

function updateRow(workbook: WorkbookSnapshot, action: Extract<InboundAction, { type: 'update_row' }>, ctx: Ctx): Result<void> {
  const table = openTable(workbook, ctx.sheetId, ctx.plan)
  if (!table.ok) return table
  const row = rowOf(table.value, action.uid)
  if (row === undefined) return fail('row_not_found')
  // `assignMode` lives outside the snapshot (D1 tasks.assign_mode); nothing to write for it.
  writeFields(workbook, table.value, ctx.plan, row.row, action.uid, action.fields, ctx)
  if (action.fields.position !== undefined) return reposition(workbook, ctx.sheetId, ctx.plan, action.uid, action.fields.position)
  return ok(undefined)
}

function uniqueSheetName(workbook: WorkbookSnapshot, base: string): string {
  const names = new Set(Object.values(workbook.sheets).map((s) => s?.name))
  if (!names.has(base)) return base
  for (let n = 2; ; n++) if (!names.has(`${base} (${n})`)) return `${base} (${n})`
}

/**
 * The «غير مصنّف» sheet: the existing one with its plan, or a new one with
 * the source sheet's header row and column settings (so its rows read the
 * same), local (not linked to any list).
 */
function unclassifiedTarget(workbook: WorkbookSnapshot, source: TaskTable, ctx: Ctx): Result<{ sheetId: string; plan: Plan }> {
  const spec = ctx.options.unclassified
  if (spec === undefined) return fail('unclassified_plan_required')
  if (workbook.sheets[spec.univerSheetId] !== undefined) {
    return spec.plan === undefined ? fail('unclassified_plan_required') : ok({ sheetId: spec.univerSheetId, plan: spec.plan })
  }
  const src = source.sheet
  const headerCells: Record<number, unknown> = {}
  for (const [c, cell] of Object.entries(rowCells(src, source.header))) {
    const copy = { ...cell }
    delete copy.custom
    headerCells[Number(c)] = copy
  }
  const name = uniqueSheetName(workbook, UNCLASSIFIED_SHEET_NAME)
  const sheet: Record<string, unknown> = {
    id: spec.univerSheetId,
    name,
    cellData: { [source.header]: headerCells },
    columnData: structuredClone(src.columnData ?? {}),
  }
  for (const key of ['rightToLeft', 'defaultStyle', 'rowCount', 'columnCount', 'defaultColumnWidth', 'defaultRowHeight'] as const) {
    if (src[key] !== undefined) sheet[key] = structuredClone(src[key])
  }
  workbook.sheets[spec.univerSheetId] = sheet
  workbook.sheetOrder = [...(workbook.sheetOrder ?? []), spec.univerSheetId]
  const plan: Plan = {
    ...ctx.plan,
    sheetId: spec.sheetId,
    // OPEN: the sheet holds to-dos of lists nobody linked; it is not linked itself (OPEN_QUESTIONS.md #10).
    mode: 'local',
    hierarchy: { mode: 'flat' },
    existingTasks: 'create_all',
  }
  delete plan.todolistId
  ctx.created.push({ univerSheetId: spec.univerSheetId, name, plan })
  return ok({ sheetId: spec.univerSheetId, plan })
}

/**
 * Moves a to-do and its subtasks to another sheet (spec §9.3.11, §16 scenario 4).
 * OPEN: refused for formulas and for values without a column in the target (OPEN_QUESTIONS.md #11).
 */
function transferFamily(
  workbook: WorkbookSnapshot,
  source: TaskTable,
  family: readonly SystemRow[],
  target: { sheetId: string; plan: Plan },
  position: number | null,
  ctx: Ctx,
): Result<void> {
  const dst = openTable(workbook, target.sheetId, target.plan)
  if (!dst.ok) return dst
  const d = dst.value

  // Columns of the source → columns of the target: system columns, mapped fields, then equal header texts.
  const map = new Map<number, number>([
    [source.system.uid, d.system.uid],
    [source.system.parentUid, d.system.parentUid],
    [source.system.level, d.system.level],
  ])
  for (const [field, column] of Object.entries(source.fields.field)) {
    const to = d.fields.field[field as keyof typeof d.fields.field]
    if (to !== undefined) map.set(column, to)
  }
  const taken = new Set(map.values())
  const byHeader = new Map<string, number>()
  for (const [c] of Object.entries(rowCells(d.sheet, d.header))) {
    const column = Number(c)
    const name = normalizeName(cellText(getCell(d.sheet, d.header, column)))
    if (name !== '' && !taken.has(column) && !byHeader.has(name)) byHeader.set(name, column)
  }
  const headerOf = (column: number): string => cellText(getCell(source.sheet, source.header, column)).trim() || columnLetters(column)
  const unplaced = new Set<string>()
  for (const member of family) {
    for (const [c, cell] of Object.entries(rowCells(source.sheet, member.row))) {
      const column = Number(c)
      if (map.has(column)) {
        if (hasFormula(cell)) return fail('move_formula_cells', headerOf(column))
        continue
      }
      const byName = byHeader.get(normalizeName(headerOf(column)))
      if (byName !== undefined && !taken.has(byName)) {
        if (hasFormula(cell)) return fail('move_formula_cells', headerOf(column))
        map.set(column, byName)
        taken.add(byName)
        continue
      }
      if (!isBlankCell(cell)) unplaced.add(headerOf(column))
    }
  }
  if (unplaced.size > 0) return fail('move_unplaced_cells', [...unplaced].join('، '))

  // Completion is read with the source's rules and written with the target's (a checkbox
  // value means nothing in a status column without one).
  const srcCompleted = source.fields.field.completed
  const completion = family.map((m) => {
    if (srcCompleted === undefined) return null
    const read = readCompleted(workbook, source.sheetId, m.row, srcCompleted, ctx.plan)
    return read.kind === 'value' ? read.completed : null
  })

  const free = freeRowsBelow(workbook, d, family.length)
  if (!free.ok) return free
  const srcNotes = readNotes(workbook, source.sheetId)
  const dstNotes = readNotes(workbook, target.sheetId)
  family.forEach((member, i) => {
    const to = free.value[i] as number
    for (const [c, cell] of Object.entries(rowCells(source.sheet, member.row))) {
      const column = map.get(Number(c))
      if (column === undefined) continue
      setCell(d.sheet, to, column, structuredClone(cell))
      const note = srcNotes[String(member.row)]?.[c]
      if (note !== undefined && note.note !== UNSYNCED_NOTE) setNote(dstNotes, to, column, structuredClone(note))
    }
    const done = completion[i]
    const dstCompleted = d.fields.field.completed
    if (done !== null && done !== undefined && dstCompleted !== undefined) {
      report(ctx, writeCompleted(workbook, target.sheetId, to, dstCompleted, target.plan, done), target.sheetId, to, dstCompleted, member.uid)
    }
  })
  writeSheetNotes(workbook, target.sheetId, dstNotes)

  // Out of the source: the other tasks close up, the last slots are emptied.
  const familyUids = new Set(family.map((m) => m.uid))
  const remaining = orderRowsOf(source).filter((r) => !familyUids.has(r.uid))
  const out = applyOrder(workbook, source.sheetId, remaining, source.rows.map((r) => r.row))
  if (!out.ok) return out

  // Into the target, at the to-do's position.
  const incoming: OrderRow[] = family.map((m, i) => ({ uid: m.uid, parentUid: m.parentUid, level: m.level, position: 0, row: free.value[i] as number }))
  const rows = [...orderRowsOf(d), ...incoming]
  const placed = placeAt(rows, (family[0] as SystemRow).uid, position)
  if (!placed.ok) return placed
  const into = applyOrder(workbook, target.sheetId, placed.value, rows.map((r) => r.row))
  if (!into.ok) return into
  return redecorate(workbook, target.sheetId, target.plan, [...familyUids], ctx)
}

function moveRow(workbook: WorkbookSnapshot, action: Extract<InboundAction, { type: 'move_row' }>, ctx: Ctx): Result<void> {
  const table = openTable(workbook, ctx.sheetId, ctx.plan)
  if (!table.ok) return table
  const row = rowOf(table.value, action.uid)
  if (row === undefined) return fail('row_not_found')
  if (row.level !== 0) return fail('invalid_hierarchy', 'move_row on a subtask')
  const linked = action.toListId === null ? null : (ctx.options.sheetForList?.(action.toListId) ?? null)
  let target = linked === null ? null : { sheetId: linked.univerSheetId, plan: linked.plan }
  if (target !== null && target.sheetId === ctx.sheetId) return reposition(workbook, ctx.sheetId, ctx.plan, action.uid, action.position)
  if (target === null) {
    const unclassified = unclassifiedTarget(workbook, table.value, ctx)
    if (!unclassified.ok) return unclassified
    target = unclassified.value
    if (target.sheetId === ctx.sheetId) return reposition(workbook, ctx.sheetId, ctx.plan, action.uid, action.position)
  }
  const family = table.value.rows.filter((r) => r.uid === action.uid || (r.level === 1 && r.parentUid === action.uid))
  return transferFamily(workbook, table.value, family, target, action.position, ctx)
}

function markRow(workbook: WorkbookSnapshot, uid: TaskUid, ctx: Ctx, apply: (table: TaskTable, row: number) => void): Result<void> {
  const table = openTable(workbook, ctx.sheetId, ctx.plan)
  if (!table.ok) return table
  const row = rowOf(table.value, uid)
  if (row === undefined) return fail('row_not_found')
  apply(table.value, row.row)
  return ok(undefined)
}

/** Sheets an action may write to, so only those are copied for it. */
function sheetsOf(action: InboundAction, ctx: Ctx): string[] {
  if (action.type !== 'move_row') return [ctx.sheetId]
  const ids = [ctx.sheetId]
  const target = action.toListId === null ? null : ctx.options.sheetForList?.(action.toListId)
  if (target) ids.push(target.univerSheetId)
  if (ctx.options.unclassified) ids.push(ctx.options.unclassified.univerSheetId)
  return ids
}

/**
 * Applies inbound actions to one sheet of a stored workbook and returns the
 * new workbook. `sheetId` is the Univer sheet id (the key in
 * `workbook.sheets`); `plan.sheetId` and `LocalTask.sheetId` are the
 * platform's (D1 `sheets.id`). `create_row` puts the new row at its position (subtasks under
 * their to-do); `update_row` writes only the mapped cells it carries (and
 * reorders for `position`); `mark_deleted_remotely` strikes the row through
 * in grey and keeps it; `restore_row` removes that marking; `move_row` moves
 * the to-do with its subtasks to the sheet of its new list, or to «غير مصنّف».
 * `rewrite_managed_block` changes nothing in the sheet (`ignored`).
 */
export function applyInbound(
  workbook: WorkbookSnapshot,
  sheetId: string,
  plan: SheetPlan,
  actions: readonly InboundAction[],
  options: ApplyInboundOptions,
): Result<ApplyInboundResult> {
  const first = openTable(workbook, sheetId, plan)
  if (!first.ok) return first
  const ctx: Ctx = { sheetId, plan, options, issues: [], created: [] }
  const outcomes: ActionOutcome[] = []
  let current = workbook
  actions.forEach((action, index) => {
    const base = { index, type: action.type, uid: action.type === 'create_row' ? action.task.uid : action.uid }
    if (action.type === 'rewrite_managed_block') {
      outcomes.push({ ...base, status: 'ignored' })
      return
    }
    const draft = editable(current, sheetsOf(action, ctx))
    const issuesBefore = ctx.issues.length
    const createdBefore = ctx.created.length
    let result: Result<void>
    switch (action.type) {
      case 'create_row':
        result = createRow(draft, action, ctx)
        break
      case 'update_row':
        result = updateRow(draft, action, ctx)
        break
      case 'mark_deleted_remotely':
        result = markRow(draft, action.uid, ctx, (table, row) => markDeleted(draft, table, row, action.status, options.deletedStyle))
        break
      case 'restore_row':
        result = markRow(draft, action.uid, ctx, (table, row) => unmarkDeleted(draft, table, row))
        break
      case 'move_row':
        result = moveRow(draft, action, ctx)
        break
    }
    if (result.ok) {
      current = draft
      outcomes.push({ ...base, status: 'applied' })
    } else {
      ctx.issues.length = issuesBefore
      ctx.created.length = createdBefore
      outcomes.push({ ...base, status: 'refused', error: result.error })
    }
  })
  return ok({
    workbook: current,
    outcomes,
    issues: ctx.issues,
    changedCells: changedCells(workbook, current),
    changedResources: changedResources(workbook, current),
    createdSheets: ctx.created,
  })
}
