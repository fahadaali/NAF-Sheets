// What changed between two snapshots, for the workbook room to broadcast
// (spec §11). The room's message protocol is not defined yet (phase 6):
// OPEN: OPEN_QUESTIONS.md #12.

import { sameJson, type WorkbookSnapshot } from './cells'

export interface CellRef {
  /** Univer sheet id (the key in `workbook.sheets`). */
  sheetId: string
  /** 0-based. */
  row: number
  /** 0-based. */
  column: number
}

/** Every cell whose stored content (value, formula, style, platform data) differs, sorted by sheet, row, column. */
export function changedCells(before: WorkbookSnapshot, after: WorkbookSnapshot): CellRef[] {
  const out: CellRef[] = []
  for (const [sheetId, sheet] of Object.entries(after.sheets)) {
    const old = before.sheets[sheetId]
    if (old === sheet) continue
    const a = (old?.cellData ?? {}) as Record<string, Record<string, unknown> | undefined>
    const b = (sheet?.cellData ?? {}) as Record<string, Record<string, unknown> | undefined>
    const rows = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const r of rows) {
      const ra = a[r] ?? {}
      const rb = b[r] ?? {}
      if (ra === rb) continue
      for (const c of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
        if (!sameJson(ra[c], rb[c])) out.push({ sheetId, row: Number(r), column: Number(c) })
      }
    }
  }
  return out.sort((x, y) => (x.sheetId < y.sheetId ? -1 : x.sheetId > y.sheetId ? 1 : x.row - y.row || x.column - y.column))
}

/** Names of plugin resources whose data differs (notes, validation ranges…). */
export function changedResources(before: WorkbookSnapshot, after: WorkbookSnapshot): string[] {
  const data = (w: WorkbookSnapshot): Map<string, string> => new Map((w.resources ?? []).map((r) => [r.name, r.data]))
  const a = data(before)
  const b = data(after)
  return [...new Set([...a.keys(), ...b.keys()])].filter((name) => a.get(name) !== b.get(name)).sort()
}

/** A copy that may be edited in place for the given sheets; every other sheet is shared, untouched. */
export function editable(workbook: WorkbookSnapshot, sheetIds: readonly string[]): WorkbookSnapshot {
  const sheets = { ...workbook.sheets }
  for (const id of new Set(sheetIds)) {
    const sheet = sheets[id]
    if (sheet !== undefined) sheets[id] = structuredClone(sheet)
  }
  const out: WorkbookSnapshot = { ...workbook, sheets }
  if (workbook.resources !== undefined) out.resources = workbook.resources.map((r) => ({ ...r }))
  if (workbook.sheetOrder !== undefined) out.sheetOrder = [...workbook.sheetOrder]
  return out
}
