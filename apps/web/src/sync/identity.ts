// A row of a synced sheet that gets a title gets a task identity at once,
// client-side (spec §6.1): a fresh uid (UUID, like every platform id) with
// its level and parent, written into the hidden system cells exactly as
// sheet-model's `writeSystemCells` writes them.

import type { ICellData } from '@univerjs/core'
import type { TaskUid } from '@naf-sheets/shared'
import { cellText, type CellReader } from './cells'
import type { SheetLayout, SystemColumns } from './layout'
import { newRowIdentity, systemCells, type TaskRow } from './rows'

type Params = Record<string, unknown> | undefined

const isCellData = (v: unknown): v is ICellData => typeof v === 'object' && v !== null && !Array.isArray(v)

/** True when `row` has a title and no uid yet. */
export function needsIdentity(reader: CellReader, layout: SheetLayout, row: number): boolean {
  const system = layout.system
  const title = layout.fields.title
  if (!system || title === undefined || row <= layout.header) return false
  return cellText(reader.cell(row, system.uid)).trim() === '' && cellText(reader.cell(row, title)).trim() !== ''
}

/**
 * `SetRangeValuesCommand` params that type a title into a row without a uid
 * → a copy that also writes the row's system cells, so the title and its
 * identity are one edit (one undo step). Null when nothing is to add.
 */
export function titleWriteWithIdentity(
  params: Params,
  layout: SheetLayout,
  reader: CellReader,
  rows: readonly TaskRow[],
  newUid: () => TaskUid,
): Record<string, unknown> | null {
  const system = layout.system as SystemColumns | null
  const title = layout.fields.title
  const range = params?.range as { startRow?: number; endRow?: number; startColumn?: number; endColumn?: number } | undefined
  if (!system || title === undefined || !range) return null
  const { startRow, endRow, startColumn, endColumn } = range
  if (startRow === undefined || startRow !== endRow || startColumn !== title || endColumn !== title || startRow <= layout.header) return null
  const value = params?.value
  if (!isCellData(value) || cellText(value).trim() === '') return null
  if (cellText(reader.cell(startRow, system.uid)).trim() !== '') return null
  const identity = newRowIdentity(rows, startRow, newUid())
  const { range: _range, value: _value, ...rest } = params ?? {}
  return { ...rest, value: { [startRow]: { ...systemCells(system, identity), [title]: value } } }
}

/** A fresh uid: a UUID, the format of every platform id (spec §6.1 `task_uid`). */
export function randomUid(): TaskUid {
  return crypto.randomUUID()
}
