// Reversible style marks the platform puts on cells: a row deleted in
// Basecamp (struck through and grey, §9.3.10), an unsynced cell of a subtask
// row (§8 note), the start indentation of a subtask's title (§5.2).
//
// The style values come from the caller (the platform's theme), never from
// this package. A mark records the values it replaced in the cell's platform
// data (`custom.nafSheets.marks`), so removing it restores exactly what was
// there; a key a person changed after the mark was applied is left as they
// set it.

import {
  nafData,
  ownStyle,
  sameJson,
  withNafData,
  type MarkName,
  type MarkRecord,
  type WorkbookSnapshot,
} from './cells'
import type { ICellData, IStyleData } from './univer'

function withStyle(cell: ICellData, style: Record<string, unknown>, workbook: WorkbookSnapshot, restoreId?: string): ICellData {
  const out: ICellData = { ...cell }
  if (restoreId !== undefined && sameJson(workbook.styles?.[restoreId] ?? {}, style)) out.s = restoreId
  else if (Object.keys(style).length > 0) out.s = style as IStyleData
  else delete out.s
  return out
}

export function hasMark(cell: ICellData | undefined, mark: MarkName): boolean {
  return nafData(cell).marks?.[mark] !== undefined
}

/** Removes a mark, restoring the keys it set that still hold its values. */
export function removeMark(workbook: WorkbookSnapshot, cell: ICellData, mark: MarkName): ICellData {
  const data = nafData(cell)
  const record = data.marks?.[mark]
  if (record === undefined) return cell
  const style = ownStyle(workbook, cell) as Record<string, unknown>
  const others = { ...(data.marks ?? {}) }
  delete others[mark]
  for (const [key, value] of Object.entries(record.set)) {
    if (!sameJson(style[key], value)) continue
    const prev = record.prev[key]
    if (prev === null || prev === undefined) delete style[key]
    else style[key] = prev
    // A mark applied later on the same key recorded this mark's value as its "before".
    for (const other of Object.values(others)) {
      if (other !== undefined && key in other.set && sameJson(other.prev[key], value)) other.prev[key] = record.prev[key] ?? null
    }
  }
  const restoreId = Object.keys(others).length === 0 ? record.sId : undefined
  const next = withStyle(cell, style, workbook, restoreId)
  return withNafData(next, { ...data, marks: others })
}

/** Applies a mark (re-applying it when the values changed). */
export function applyMark(workbook: WorkbookSnapshot, cell: ICellData, mark: MarkName, patch: IStyleData): ICellData {
  const current = nafData(cell).marks?.[mark]
  if (current !== undefined && sameJson(current.set, patch)) return cell
  const base = current !== undefined ? removeMark(workbook, cell, mark) : cell
  const data = nafData(base)
  const style = ownStyle(workbook, base) as Record<string, unknown>
  const record: MarkRecord = { set: {}, prev: {} }
  if (typeof base.s === 'string') record.sId = base.s
  else {
    const firstId = Object.values(data.marks ?? {}).find((m) => m?.sId !== undefined)?.sId
    if (firstId !== undefined) record.sId = firstId
  }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue
    record.prev[key] = key in style ? (style[key] ?? null) : null
    record.set[key] = value
    style[key] = value
  }
  const next = withStyle(base, style, workbook)
  return withNafData(next, { ...data, marks: { ...(data.marks ?? {}), [mark]: record } })
}
