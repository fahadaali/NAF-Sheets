// Tab / Shift+Tab on a synced sheet (spec §8): the change is computed by
// @naf-sheets/sheet-model's `indentTaskRow` / `outdentTaskRow` on a copy of
// the live workbook — the same function the server would run, with the same
// sync-engine rules and Arabic refusals — and handed back as cell writes the
// editor applies with one `SetRangeValuesCommand` (one undo step).
//
// A write is a patch in Univer's `SetRangeValuesMutation` terms: a key set to
// `null` is removed (`custom`, `p`, `f`, `si`, `v`), and a style is merged
// key by key, so a style key the edit removed is sent as `null`.

import type { ICellData, IStyleData } from '@univerjs/core'
import { indentTaskRow, outdentTaskRow, type WorkbookSnapshot } from '@naf-sheets/sheet-model'
import type { TaskUid } from '@naf-sheets/shared'
import type { SheetLayout } from './layout'

export interface CellWrite {
  row: number
  column: number
  patch: Record<string, unknown>
}

export interface NoteChange {
  row: number
  column: number
  /** Null removes the note. */
  note: { note: string; width: number; height: number } | null
}

export type HierarchyEdit = { ok: true; writes: CellWrite[]; notes: NoteChange[] } | { ok: false; message: string }

export interface HierarchyOptions {
  /** Start padding of a subtask's title, in pixels (theme `--subtask-indent`). */
  subtaskIndent?: number
}

type Styles = Record<string, IStyleData | null | undefined> | undefined

function styleOf(cell: ICellData | undefined, styles: Styles): Record<string, unknown> {
  const s = cell?.s
  if (s === undefined || s === null) return {}
  if (typeof s === 'string') return { ...((styles?.[s] as Record<string, unknown> | undefined) ?? {}) }
  return { ...(s as Record<string, unknown>) }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** What turns `before` into `after` through Univer's cell merge. Null when they are equal. */
export function cellPatch(before: ICellData | undefined, after: ICellData | undefined, stylesBefore: Styles, stylesAfter: Styles): Record<string, unknown> | null {
  const a = (before ?? {}) as Record<string, unknown>
  const b = (after ?? {}) as Record<string, unknown>
  const patch: Record<string, unknown> = {}
  for (const key of ['p', 'f', 'si', 'custom'] as const) {
    if (b[key] !== undefined && b[key] !== null) {
      if (!same(a[key], b[key])) patch[key] = b[key]
    } else if (a[key] !== undefined && a[key] !== null) patch[key] = null
  }
  if (b.v !== undefined && b.v !== null) {
    if (!same(a.v, b.v) || !same(a.t, b.t)) {
      patch.v = b.v
      if (b.t !== undefined) patch.t = b.t
    }
  } else if (a.v !== undefined && a.v !== null) patch.v = null
  const sa = styleOf(before, stylesBefore)
  const sb = styleOf(after, stylesAfter)
  if (!same(sortKeys(sa), sortKeys(sb))) {
    const s: Record<string, unknown> = { ...sb }
    for (const key of Object.keys(sa)) if (!(key in sb)) s[key] = null
    patch.s = s
  }
  return Object.keys(patch).length === 0 ? null : patch
}

function sortKeys(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
}

type NoteMap = Record<string, Record<string, { note?: string; width?: number; height?: number }>>

function notesOf(workbook: WorkbookSnapshot, sheetId: string): NoteMap {
  const entry = workbook.resources?.find((r) => r.name === 'SHEET_NOTE_PLUGIN')
  if (!entry?.data) return {}
  try {
    const all = JSON.parse(entry.data) as Record<string, NoteMap>
    return all[sheetId] ?? {}
  } catch {
    return {}
  }
}

function noteChanges(before: NoteMap, after: NoteMap): NoteChange[] {
  const out: NoteChange[] = []
  const rows = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const r of rows) {
    const cols = new Set([...Object.keys(before[r] ?? {}), ...Object.keys(after[r] ?? {})])
    for (const c of cols) {
      const a = before[r]?.[c]
      const b = after[r]?.[c]
      if (same(a, b)) continue
      out.push({
        row: Number(r),
        column: Number(c),
        note: b ? { note: String(b.note ?? ''), width: Number(b.width ?? 160), height: Number(b.height ?? 72) } : null,
      })
    }
  }
  return out
}

type Cells = Record<string, Record<string, ICellData | undefined> | undefined>

/** The writes that indent (`indent`) or outdent (`outdent`) the task `uid` of `layout`'s sheet in `workbook`. */
export function planHierarchyEdit(workbook: WorkbookSnapshot, layout: SheetLayout, uid: TaskUid, op: 'indent' | 'outdent', options: HierarchyOptions = {}): HierarchyEdit {
  if (!layout.plan) return { ok: false, message: '' }
  const decoration = options.subtaskIndent !== undefined ? { subtaskIndent: options.subtaskIndent } : {}
  const run = op === 'indent' ? indentTaskRow : outdentTaskRow
  const result = run(workbook, layout.sheetId, layout.plan, uid, decoration)
  if (!result.ok) return { ok: false, message: result.error.message }
  const next = result.value.workbook
  const beforeCells = (workbook.sheets[layout.sheetId]?.cellData ?? {}) as Cells
  const afterCells = (next.sheets[layout.sheetId]?.cellData ?? {}) as Cells
  const writes: CellWrite[] = []
  for (const ref of result.value.changedCells) {
    if (ref.sheetId !== layout.sheetId) continue
    const patch = cellPatch(beforeCells[ref.row]?.[ref.column], afterCells[ref.row]?.[ref.column], workbook.styles as Styles, next.styles as Styles)
    if (patch) writes.push({ row: ref.row, column: ref.column, patch })
  }
  return { ok: true, writes, notes: noteChanges(notesOf(workbook, layout.sheetId), notesOf(next, layout.sheetId)) }
}

/** The writes as one `SetRangeValuesCommand` value (an object matrix, no range). */
export function writesAsMatrix(writes: readonly CellWrite[]): Record<number, Record<number, Record<string, unknown>>> {
  const out: Record<number, Record<number, Record<string, unknown>>> = {}
  for (const w of writes) (out[w.row] ??= {})[w.column] = w.patch
  return out
}
