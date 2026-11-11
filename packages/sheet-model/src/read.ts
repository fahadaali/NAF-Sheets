// Task rows of a synced sheet, as the sync engine reads them (spec §6.1, §8, §9.2).

import { isDashboardSheet } from '@naf-sheets/shared'
import type { AssignMode, Assignee, AttachmentRef, IsoDateTime, LocalTask, SheetPlan, TaskUid } from '@naf-sheets/shared'
import { columnLetters } from './a1'
import { cellText, getCell, nafData, type WorkbookSnapshot } from './cells'
import { isValidHierarchy, renumber } from './engine'
import { fail, issue, ok, type Result, type SheetIssue } from './errors'
import {
  fieldColumns,
  readCompleted,
  readDateCell,
  readNotes,
  resolveAssignee,
  splitAssigneeText,
  type AssigneeDirectory,
} from './fields'
import { headerIndex, readSystemRows, requireSystemColumns } from './system-columns'

/** What the platform keeps about a row outside the snapshot (D1 `tasks`, `task_assignees`). */
export interface RowState {
  bcId?: number | null
  assignMode?: AssignMode
  localChangedAt?: IsoDateTime | null
  attachments?: AttachmentRef[]
  /** Stored assignees: a name in the cell that matches one of them keeps its kind, source and e-mail setting. */
  assignees?: Assignee[]
  deletedRemotely?: boolean
}

export interface ReadTasksOptions {
  directory?: AssigneeDirectory
  rowState?: (uid: TaskUid) => RowState | undefined
}

export interface ReadTasksResult {
  /** Rows with a usable identity, in sheet order. */
  tasks: LocalTask[]
  /**
   * Rows or cells that need attention. A task with an issue is still listed
   * (its identity is sound) but must not be sent to Basecamp until the issue
   * is resolved: an unreadable date, for example, reads as null.
   */
  issues: SheetIssue[]
}

/**
 * Subtasks that are not right under their to-do (spec §8). The rule is the
 * engine's `isValidHierarchy`; this only finds which rows break it.
 */
function misplacedSubtasks(rows: ReadonlyArray<Pick<LocalTask, 'uid' | 'parentUid' | 'level' | 'position'>>): Set<TaskUid> {
  const out = new Set<TaskUid>()
  if (isValidHierarchy(rows)) return out
  let currentParent: TaskUid | null = null
  for (const row of rows) {
    if (row.level === 0) currentParent = row.uid
    else if (row.parentUid === null || row.parentUid !== currentParent) out.add(row.uid)
  }
  return out
}

/**
 * The task rows of one sheet. `sheetId` is the Univer sheet id (the key in
 * `workbook.sheets`); `LocalTask.sheetId` is the platform's, from the plan. Identity is the `__uid` cell, never the row
 * number: sorting the sheet changes positions, not identities. `position` is
 * the 1-based order among siblings (to-dos in the sheet, subtasks in their
 * to-do), by row order.
 */
export function readTasks(
  workbook: WorkbookSnapshot,
  sheetId: string,
  plan: Pick<SheetPlan, 'sheetId' | 'headerRow' | 'columns' | 'completedValues' | 'assigneeMatches'>,
  options: ReadTasksOptions = {},
): Result<ReadTasksResult> {
  const sheet = workbook.sheets[sheetId]
  if (sheet === undefined) return fail('sheet_not_found')
  // The dashboard tab «اللوحة» holds no tasks (@naf-sheets/shared dashboard-sheet.ts).
  if (isDashboardSheet(sheet)) return fail('dashboard_sheet')
  const header = headerIndex(plan)
  if (header === null) return fail('invalid_header_row')
  const cols = fieldColumns(plan)
  if (!cols.ok) return cols
  const system = requireSystemColumns(sheet, header)
  if (!system.ok) return system
  const { field, title, free } = cols.value

  const read = readSystemRows(sheet, sheetId, header, system.value, title)
  const issues: SheetIssue[] = [...read.issues]
  const hierarchy = read.rows.map((r) => ({ uid: r.uid, parentUid: r.parentUid, level: r.level, position: 0 }))
  const misplaced = misplacedSubtasks(hierarchy)
  const positioned = renumber(hierarchy)
  const freeHeaders = free
    .filter((f) => f.appendToDescription)
    .map((f) => ({ column: f.column, header: cellText(getCell(sheet, header, f.column)).trim() || columnLetters(f.column) }))

  const tasks: LocalTask[] = read.rows.map((row, index) => {
    const at = { sheetId, row: row.row, uid: row.uid }
    const state = options.rowState?.(row.uid)
    if (misplaced.has(row.uid)) issues.push(issue('invalid_hierarchy', at))

    const titleText = cellText(getCell(sheet, row.row, title)).trim()
    if (titleText === '') issues.push(issue('empty_title', { ...at, column: title }))

    const assignees: Assignee[] = []
    if (field.assignees !== undefined) {
      const known = state?.assignees ?? []
      for (const name of splitAssigneeText(cellText(getCell(sheet, row.row, field.assignees)))) {
        const resolved = resolveAssignee(name, plan, options.directory, known)
        if (resolved.kind === 'assignee') assignees.push(resolved.assignee)
        else if (resolved.kind === 'unknown') issues.push(issue('unknown_assignee', { ...at, column: field.assignees, detail: name }))
        else if (resolved.kind === 'ambiguous') issues.push(issue('ambiguous_assignee', { ...at, column: field.assignees, detail: name }))
      }
    }

    const date = (column: number | undefined): string | null => {
      if (column === undefined) return null
      const value = readDateCell(getCell(sheet, row.row, column), workbook.dateSystem)
      if (value.kind === 'invalid') issues.push(issue('invalid_date', { ...at, column, detail: value.text }))
      return value.kind === 'date' ? value.date : null
    }
    const dueOn = date(field.due_on)
    const startsOn = date(field.starts_on)

    let completed = false
    if (field.completed !== undefined) {
      const value = readCompleted(workbook, sheetId, row.row, field.completed, plan)
      if (value.kind === 'checkbox_formula') issues.push(issue('checkbox_formula', { ...at, column: field.completed }))
      else completed = value.completed
    }

    const freeColumnsForDescription: Record<string, string> = {}
    for (const f of freeHeaders) {
      const value = cellText(getCell(sheet, row.row, f.column)).trim()
      if (value !== '') freeColumnsForDescription[f.header] = value
    }

    const uidCell = getCell(sheet, row.row, system.value.uid)
    const task: LocalTask = {
      uid: row.uid,
      // The platform's sheet id (D1 sheets.id), as the plan carries it.
      sheetId: plan.sheetId,
      parentUid: row.parentUid,
      level: row.level,
      position: positioned[index]?.position ?? 0,
      title: titleText,
      assignees,
      dueOn,
      startsOn,
      completed,
      notesHtml: field.notes !== undefined ? readNotes(getCell(sheet, row.row, field.notes)) : null,
      freeColumnsForDescription,
      attachments: state?.attachments ?? [],
      // OPEN: without the stored mode, §8.1's default for a new row (OPEN_QUESTIONS.md #20).
      assignMode: state?.assignMode ?? (row.level === 0 && assignees.length > 0 ? 'manual' : 'auto'),
      localChangedAt: state?.localChangedAt ?? null,
      bcId: state?.bcId ?? null,
      deletedRemotely: state?.deletedRemotely ?? nafData(uidCell).deletedRemotely !== undefined,
    }
    return task
  })
  return ok({ tasks, issues })
}
