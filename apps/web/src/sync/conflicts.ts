// Field conflicts (spec §9.1: last writer wins, logged, shown on the cell,
// the other value restorable): where each sits in the sheet and how its two
// values read.

import type { Assignee, AssigneeOptionsResponse, ConflictRecord, FieldConflict } from '@naf-sheets/shared'
import { t } from '../strings'
import type { LayoutField, SheetLayout } from './layout'
import type { TaskRow } from './rows'

/** The mapped column a conflicting field lives in; null for row-level fields (order, list). */
export const CONFLICT_FIELD_COLUMN: Readonly<Record<FieldConflict['field'], LayoutField | null>> = {
  title: 'title',
  assignees: 'assignees',
  dueOn: 'due_on',
  startsOn: 'starts_on',
  completed: 'completed',
  notesHtml: 'notes',
  position: null,
  listId: null,
}

export interface ConflictCell {
  conflict: ConflictRecord
  row: number
  /** The field's column; the title column for order and list conflicts. */
  column: number
}

/** The cell of each conflict on this sheet whose row is present. OPEN: order and list conflicts sit on the title (OPEN_QUESTIONS.md #47). */
export function conflictCells(conflicts: readonly ConflictRecord[], rows: readonly TaskRow[], layout: SheetLayout): ConflictCell[] {
  const byUid = new Map(rows.map((r) => [r.uid, r.row]))
  const out: ConflictCell[] = []
  for (const conflict of conflicts) {
    if (conflict.sheetId !== layout.metaId) continue
    const row = byUid.get(conflict.uid)
    if (row === undefined) continue
    const field = CONFLICT_FIELD_COLUMN[conflict.field]
    const column = (field !== null ? layout.fields[field] : undefined) ?? layout.fields.title
    if (column === undefined) continue
    out.push({ conflict, row, column })
  }
  return out
}

const stripHtml = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()

function personName(id: number, options: AssigneeOptionsResponse | null): string {
  const person = options?.projectPeople.find((p) => p.id === id) ?? options?.accountPeople.find((p) => p.id === id)
  return person?.name ?? t.conflicts.person(id)
}

/**
 * A conflict value as Arabic text. Assignees arrive as Basecamp ids (remote)
 * or the platform's `Assignee` list (local).
 */
export function formatConflictValue(field: FieldConflict['field'], value: unknown, options: AssigneeOptionsResponse | null = null): string {
  if (value === null || value === undefined || value === '') return t.conflicts.emptyValue
  switch (field) {
    case 'completed':
      return value === true ? t.conflicts.completedTrue : value === false ? t.conflicts.completedFalse : String(value)
    case 'notesHtml':
      return typeof value === 'string' ? stripHtml(value) || t.conflicts.emptyValue : String(value)
    case 'assignees': {
      if (!Array.isArray(value)) return String(value)
      if (value.length === 0) return t.conflicts.emptyValue
      return value
        .map((a: unknown) => {
          if (typeof a === 'number') return personName(a, options)
          const assignee = a as Assignee
          if (assignee?.kind === 'external') return options?.externals.find((e) => e.id === assignee.externalContactId)?.name ?? t.assignee.externalTag
          if (assignee && typeof assignee.bcPersonId === 'number') return personName(assignee.bcPersonId, options)
          return String(a)
        })
        .join('، ')
    }
    default:
      return typeof value === 'object' ? JSON.stringify(value) : String(value)
  }
}

export const conflictFieldLabel = (field: FieldConflict['field']): string => t.conflicts.fields[field] ?? field
