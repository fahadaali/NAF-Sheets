// How a server change (updateLatestSnapshot while a session is live) reaches
// the open editors. The change is a pure function of the whole snapshot, so
// the room compares the snapshot before and after:
//
// - only cell contents changed: the difference becomes ordinary Univer
//   mutations (delete the changed cells, then write their new contents),
//   applied in the room and broadcast like any op;
// - anything else changed (rows inserted, sheets added, plugin resources,
//   row/column/sheet properties): the room reloads from the new snapshot and
//   every editor resyncs.
//
// A plan is checked after it is applied (`cellsMatch`); a mismatch falls back
// to the reload, so a wrong plan can only cost a resync, never divergence.

import type { RoomMutation } from '@naf-sheets/shared'
import type { Span } from './footprint'

type Json = Record<string, unknown>

const SET_RANGE_VALUES = 'sheet.mutation.set-range-values'

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Structural equality of JSON values (key order ignored). */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => sameJson(x, b[i]))
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined)
    const kb = Object.keys(b).filter((k) => b[k] !== undefined)
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameJson(a[k], b[k]))
  }
  return false
}

export interface ChangedCell {
  sheet: string
  row: number
  column: number
  /** The cell after the change with its style resolved to an object, or null when removed. */
  cell: Json | null
}

export type ServerChangePlan = { kind: 'none' } | { kind: 'cells'; cells: ChangedCell[] } | { kind: 'reset' }

function resolveStyle(cell: Json, styles: unknown): Json {
  if (typeof cell.s !== 'string') return cell
  const style = isObject(styles) ? styles[cell.s] : undefined
  const out = { ...cell }
  if (isObject(style)) out.s = style
  else delete out.s
  return out
}

function cellMatrix(sheet: unknown): Record<string, Record<string, unknown>> {
  const data = isObject(sheet) ? sheet.cellData : undefined
  return (isObject(data) ? data : {}) as Record<string, Record<string, unknown>>
}

/** Compares two workbook snapshots; see the module comment. */
export function planServerChange(before: Json, after: Json): ServerChangePlan {
  const top = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const key of top) {
    if (key === 'sheets' || key === 'styles' || key === 'resources') continue
    if (!sameJson(before[key], after[key])) return { kind: 'reset' }
  }
  if (!sameJson(resourceMap(before.resources), resourceMap(after.resources))) return { kind: 'reset' }
  const sb = isObject(before.sheets) ? before.sheets : {}
  const sa = isObject(after.sheets) ? after.sheets : {}
  if (!sameJson(Object.keys(sb).sort(), Object.keys(sa).sort())) return { kind: 'reset' }

  const cells: ChangedCell[] = []
  for (const sheetId of Object.keys(sa)) {
    const a = sa[sheetId]
    const b = sb[sheetId]
    if (!isObject(a) || !isObject(b)) return { kind: 'reset' }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const k of keys) if (k !== 'cellData' && !sameJson(a[k], b[k])) return { kind: 'reset' }
    const ma = cellMatrix(a)
    const mb = cellMatrix(b)
    for (const r of new Set([...Object.keys(ma), ...Object.keys(mb)])) {
      const ra = isObject(ma[r]) ? ma[r] : {}
      const rb = isObject(mb[r]) ? mb[r] : {}
      for (const c of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
        const ca = ra[c]
        const cb = rb[c]
        const resolvedA = isObject(ca) ? resolveStyle(ca, after.styles) : null
        const resolvedB = isObject(cb) ? resolveStyle(cb, before.styles) : null
        if (sameJson(resolvedA, resolvedB)) continue
        const row = Number(r)
        const column = Number(c)
        if (!Number.isInteger(row) || !Number.isInteger(column) || row < 0 || column < 0) return { kind: 'reset' }
        cells.push({ sheet: sheetId, row, column, cell: resolvedA && Object.keys(resolvedA).length > 0 ? resolvedA : null })
      }
    }
  }
  return cells.length === 0 ? { kind: 'none' } : { kind: 'cells', cells }
}

function resourceMap(resources: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!Array.isArray(resources)) return out
  for (const r of resources) {
    if (!isObject(r) || typeof r.name !== 'string') continue
    let data: unknown = r.data
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data)
      } catch {
        // Compared as text.
      }
    }
    // Univer saves an empty plugin as "{}" or "[]"; a missing entry means the same.
    if ((isObject(data) && Object.keys(data).length === 0) || (Array.isArray(data) && data.length === 0) || data === '') continue
    out[r.name] = data
  }
  return out
}

/** The mutations that turn the room's cells into the planned ones: delete every changed cell, then write the new contents. */
export function cellMutations(unitId: string, cells: readonly ChangedCell[]): RoomMutation[] {
  const bySheet = new Map<string, ChangedCell[]>()
  for (const c of cells) bySheet.set(c.sheet, [...(bySheet.get(c.sheet) ?? []), c])
  const out: RoomMutation[] = []
  for (const [sheet, list] of bySheet) {
    const clear: Record<number, Record<number, null>> = {}
    const write: Record<number, Record<number, Json>> = {}
    for (const c of list) {
      ;(clear[c.row] ??= {})[c.column] = null
      if (c.cell) (write[c.row] ??= {})[c.column] = c.cell
    }
    out.push({ id: SET_RANGE_VALUES, params: { unitId, subUnitId: sheet, cellValue: clear } })
    if (Object.keys(write).length > 0) out.push({ id: SET_RANGE_VALUES, params: { unitId, subUnitId: sheet, cellValue: write } })
  }
  return out
}

/** The changed cells as footprint spans. */
export function cellSpans(cells: readonly ChangedCell[]): Span[] {
  return cells.map((c) => ({ sheet: c.sheet, r0: c.row, r1: c.row, c0: c.column, c1: c.column }))
}

/**
 * True when every planned cell reads back from the room's saved snapshot as
 * planned: the same formula, rich text and custom data, the same style, and
 * the same value for cells without a formula (the engine computes the rest).
 */
export function cellsMatch(saved: Json, cells: readonly ChangedCell[]): boolean {
  const sheets = isObject(saved.sheets) ? saved.sheets : {}
  for (const c of cells) {
    const raw = cellMatrix(sheets[c.sheet])[String(c.row)]?.[String(c.column)]
    const got = isObject(raw) ? resolveStyle(raw, saved.styles) : null
    const want = c.cell
    const hasContent = (x: Json | null) => x !== null && (x.v !== undefined && x.v !== null || !!x.f || !!x.si || !!x.p)
    if (!want) {
      if (hasContent(got)) return false
      continue
    }
    if (!got) return false
    const formula = !!want.f || !!want.si
    for (const key of ['f', 'si', 'p', 'custom']) if (!sameJson(want[key] ?? null, got[key] ?? null)) return false
    if (!formula && !sameJson(want.v ?? null, got.v ?? null)) return false
    if (!sameJson(want.s ?? null, got.s ?? null)) return false
  }
  return true
}
