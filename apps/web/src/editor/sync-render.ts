// What the editor draws into the grid for synced sheets. The grid is a
// canvas, so these are Univer sheet extensions drawn in the sheet's own
// coordinates: they follow scrolling, zoom, frozen panes and hidden rows
// exactly as cells do (never `FRange.getCellRect()`, which ignores scroll and
// zoom), and the right-to-left layer mirrors them with the rest of the grid.
//
// - Row header: the row's sync state as a Lucide icon (spec §5.2). Drawn as
//   an image, which @naf-sheets/univer-rtl flips back in place, so the icon
//   reads unmirrored on the mirrored grid.
// - Cells: a light hatch over a subtask's cells Basecamp has no field for
//   (spec §8 note; Univer styles have no pattern fill), a corner marker on a
//   cell with a field conflict (§9.1), and the badge «محذوفة في Basecamp»
//   after the last column of a row deleted in Basecamp (§9.3.10).
//
// Colours and sizes come from theme.css (read once with getComputedStyle).

import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { CircleCheck, CircleExclamationPoint, Clock, Trash2, TriangleExclamationPoint } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { SheetExtension } from '@univerjs/engine-render'
import type { SpreadsheetSkeleton, UniverRenderingContext } from '@univerjs/engine-render'
import type { RowState } from '../sync/sync-state'

export interface GridTheme {
  state: Record<RowState, string>
  hatch: string
  hatchAlpha: number
  hatchSpacing: number
  conflict: string
  conflictSize: number
  rowMarginWidth: number
  indicatorSize: number
  subtaskIndent: number
  badgeBackground: string
  badgeText: string
  font: string
}

const css = (style: CSSStyleDeclaration, name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
const num = (style: CSSStyleDeclaration, name: string, fallback: number) => {
  const n = Number.parseFloat(style.getPropertyValue(name))
  return Number.isFinite(n) ? n : fallback
}

/** The theme values the canvas needs (theme.css is the only place they are defined). */
export function readGridTheme(): GridTheme {
  const style = getComputedStyle(document.documentElement)
  return {
    state: {
      synced: css(style, '--row-state-synced', 'currentColor'),
      pending: css(style, '--row-state-pending', 'currentColor'),
      error: css(style, '--row-state-error', 'currentColor'),
      conflict: css(style, '--row-state-conflict', 'currentColor'),
      deleted: css(style, '--row-state-deleted', 'currentColor'),
    },
    hatch: css(style, '--unsynced-hatch', 'currentColor'),
    hatchAlpha: num(style, '--unsynced-hatch-alpha', 0.45),
    hatchSpacing: num(style, '--unsynced-hatch-spacing', 6),
    conflict: css(style, '--conflict-marker', 'currentColor'),
    conflictSize: num(style, '--conflict-marker-size', 8),
    rowMarginWidth: num(style, '--row-margin-width', 64),
    indicatorSize: num(style, '--row-indicator-size', 14),
    subtaskIndent: num(style, '--subtask-indent', 16),
    badgeBackground: css(style, '--color-neutral-soft', 'transparent'),
    badgeText: css(style, '--color-neutral', 'currentColor'),
    font: css(style, '--font-sans', 'sans-serif'),
  }
}

export const STATE_ICONS: Record<RowState, LucideIcon> = {
  synced: CircleCheck,
  pending: Clock,
  error: TriangleExclamationPoint,
  conflict: CircleExclamationPoint,
  deleted: Trash2,
}

/** A Lucide icon as an image (SVG markup rendered by React, then loaded). */
function iconImage(Icon: LucideIcon, color: string, size: number): Promise<HTMLImageElement> {
  const host = document.createElement('div')
  const root = createRoot(host)
  flushSync(() => root.render(createElement(Icon, { color, size, strokeWidth: 2.25 })))
  const svg = host.innerHTML.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ')
  root.unmount()
  const image = new Image(size, size)
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  return image.decode().then(
    () => image,
    () => image,
  )
}

export async function loadStateIcons(theme: GridTheme): Promise<Record<RowState, HTMLImageElement>> {
  const size = theme.indicatorSize
  const entries = await Promise.all(
    (Object.keys(STATE_ICONS) as RowState[]).map(async (state) => [state, await iconImage(STATE_ICONS[state], theme.state[state], size * 2)] as const),
  )
  return Object.fromEntries(entries) as Record<RowState, HTMLImageElement>
}

/** What one synced sheet shows in the grid, by 0-based row. */
export interface SheetMarks {
  states: Map<number, RowState>
  /** Subtask rows and the columns of theirs that do not sync. */
  unsynced: { rows: ReadonlySet<number>; columns: readonly number[] }
  /** Cells with a field conflict: `row:column`. */
  conflicts: ReadonlySet<string>
  /** Rows deleted in Basecamp, and the column the badge starts in. */
  deleted: { rows: ReadonlySet<number>; column: number }
}

export type MarksBySheet = Map<string, SheetMarks>

type Ctx = UniverRenderingContext
type ViewRange = { startRow: number; endRow: number; startColumn: number; endColumn: number }

export function rowBounds(skeleton: SpreadsheetSkeleton, row: number): [number, number] | null {
  const acc = skeleton.rowHeightAccumulation
  const bottom = acc[row]
  if (bottom === undefined) return null
  const top = row === 0 ? 0 : (acc[row - 1] ?? 0)
  return bottom > top ? [top, bottom] : null
}

export function columnBounds(skeleton: SpreadsheetSkeleton, column: number): [number, number] | null {
  const acc = skeleton.columnWidthAccumulation
  const right = acc[column]
  if (right === undefined) return null
  const left = column === 0 ? 0 : (acc[column - 1] ?? 0)
  return right > left ? [left, right] : null
}

/** Row header: the sync state icon at the outer edge of the row number. OPEN: hover only; the panel has it all (OPEN_QUESTIONS.md #46). */
export class RowStateExtension extends SheetExtension {
  override uKey = 'naf-row-sync-state'
  override Z_INDEX = 20

  constructor(
    private readonly marks: () => MarksBySheet,
    private readonly icons: () => Record<RowState, HTMLImageElement> | null,
    private readonly theme: GridTheme,
  ) {
    super()
  }

  override draw(ctx: Ctx, _parentScale: unknown, skeleton: SpreadsheetSkeleton): void {
    const sheet = this.marks().get(skeleton.worksheet.getSheetId())
    const icons = this.icons()
    if (!sheet || !icons || sheet.states.size === 0) return
    const { startRow, endRow } = skeleton.rowColumnSegment
    const size = this.theme.indicatorSize
    for (let row = Math.max(0, startRow - 1); row <= endRow; row++) {
      const state = sheet.states.get(row)
      if (!state) continue
      const bounds = rowBounds(skeleton, row)
      if (!bounds) continue
      const [top, bottom] = bounds
      const height = Math.min(size, bottom - top - 2)
      if (height < 6) continue
      ctx.drawImage(icons[state], 3, top + (bottom - top - height) / 2, height, height)
    }
  }
}

/** Cells: hatch on unsynced subtask cells, conflict markers, «محذوفة في Basecamp» badges. */
export class CellMarksExtension extends SheetExtension {
  override uKey = 'naf-cell-sync-marks'
  // Above cell backgrounds (21), below text (45) and borders (50).
  override Z_INDEX = 30

  constructor(
    private readonly marks: () => MarksBySheet,
    private readonly theme: GridTheme,
    private readonly badgeText: string,
  ) {
    super()
  }

  override draw(ctx: Ctx, _parentScale: unknown, skeleton: SpreadsheetSkeleton, _diff?: unknown, more?: { viewRanges?: ViewRange[] }): void {
    const sheet = this.marks().get(skeleton.worksheet.getSheetId())
    if (!sheet) return
    const segment = skeleton.rowColumnSegment
    const views: ViewRange[] = more?.viewRanges?.length ? more.viewRanges : [segment]
    const inView = (row: number, column: number) => views.some((v) => row >= v.startRow && row <= v.endRow && column >= v.startColumn && column <= v.endColumn)
    const rowInView = (row: number) => views.some((v) => row >= v.startRow && row <= v.endRow)

    ctx.save()
    // Hatch.
    ctx.strokeStyle = this.theme.hatch
    ctx.globalAlpha = this.theme.hatchAlpha
    ctx.lineWidth = 1
    const step = Math.max(3, this.theme.hatchSpacing)
    for (const row of sheet.unsynced.rows) {
      const rb = rowBounds(skeleton, row)
      if (!rb) continue
      for (const column of sheet.unsynced.columns) {
        if (!inView(row, column)) continue
        const cb = columnBounds(skeleton, column)
        if (!cb) continue
        const [left, right] = cb
        const [top, bottom] = rb
        ctx.save()
        ctx.beginPath()
        ctx.rect(left, top, right - left, bottom - top)
        ctx.clip()
        ctx.beginPath()
        for (let d = -(bottom - top); d < right - left; d += step) {
          ctx.moveTo(left + d, bottom)
          ctx.lineTo(left + d + (bottom - top), top)
        }
        ctx.stroke()
        ctx.restore()
      }
    }
    ctx.globalAlpha = 1

    // Conflict markers: a triangle in the cell's start corner (model left = start).
    ctx.fillStyle = this.theme.conflict
    const size = this.theme.conflictSize
    for (const key of sheet.conflicts) {
      const [row, column] = key.split(':').map(Number) as [number, number]
      if (!inView(row, column)) continue
      const rb = rowBounds(skeleton, row)
      const cb = columnBounds(skeleton, column)
      if (!rb || !cb) continue
      ctx.beginPath()
      ctx.moveTo(cb[0], rb[0])
      ctx.lineTo(cb[0] + size, rb[0])
      ctx.lineTo(cb[0], rb[0] + size)
      ctx.closePath()
      ctx.fill()
    }

    // «محذوفة في Basecamp» after the row's last column.
    const cb = columnBounds(skeleton, sheet.deleted.column)
    if (cb) {
      ctx.font = `12px ${this.theme.font}`
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      const width = ctx.measureText(this.badgeText).width + 12
      for (const row of sheet.deleted.rows) {
        if (!rowInView(row)) continue
        const rb = rowBounds(skeleton, row)
        if (!rb) continue
        const [top, bottom] = rb
        const h = Math.min(18, bottom - top - 4)
        if (h < 8) continue
        const y = top + (bottom - top - h) / 2
        ctx.fillStyle = this.theme.badgeBackground
        ctx.beginPath()
        ctx.rect(cb[0] + 4, y, width, h)
        ctx.fill()
        ctx.fillStyle = this.theme.badgeText
        ctx.fillText(this.badgeText, cb[0] + 10, y + h / 2)
      }
    }
    ctx.restore()
  }
}
