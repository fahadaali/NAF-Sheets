// Other people's cells in the grid (spec §11: "a coloured frame around the
// cell each person edits"). Drawn as a Univer sheet extension in the sheet's
// own coordinates, like the synced-sheet marks (src/editor/sync-render.ts):
// the frames follow scrolling, zoom, frozen panes and hidden rows exactly as
// cells do (never `FRange.getCellRect()`, which ignores scroll and zoom), and
// the right-to-left layer mirrors them with the rest of the grid. They carry no
// text, so nothing in them needs to be flipped back: names are in the avatar
// list and the cell's tooltip.
//
// Colours come from theme.css (`--presence-1` … `--presence-6`).

import { SheetExtension } from '@univerjs/engine-render'
import type { SpreadsheetSkeleton, UniverRenderingContext } from '@univerjs/engine-render'
import { columnBounds, rowBounds } from '../editor/sync-render'
import { PRESENCE_COLOURS } from './presence'
import type { CellMark } from './presence'

export interface PresenceTheme {
  colours: string[]
  lineWidth: number
  /** Opacity of the wash over a locked cell. */
  lockAlpha: number
}

/** The theme values the canvas needs (read once with getComputedStyle). */
export function readPresenceTheme(): PresenceTheme {
  const style = getComputedStyle(document.documentElement)
  const value = (name: string) => style.getPropertyValue(name).trim()
  const number = (name: string, fallback: number) => {
    const n = Number.parseFloat(value(name))
    return Number.isFinite(n) ? n : fallback
  }
  return {
    colours: Array.from({ length: PRESENCE_COLOURS }, (_, i) => value(`--presence-${i + 1}`) || 'currentColor'),
    lineWidth: number('--presence-line-width', 2),
    lockAlpha: number('--presence-lock-alpha', 0.12),
  }
}

export class PresenceExtension extends SheetExtension {
  override uKey = 'naf-presence-frames'
  // Above text (45) and borders (50).
  override Z_INDEX = 55

  constructor(
    private readonly marks: (sheetId: string) => readonly CellMark[],
    private readonly theme: PresenceTheme,
  ) {
    super()
  }

  override draw(ctx: UniverRenderingContext, _parentScale: unknown, skeleton: SpreadsheetSkeleton): void {
    const marks = this.marks(skeleton.worksheet.getSheetId())
    if (marks.length === 0) return
    ctx.save()
    for (const mark of marks) {
      const rb = rowBounds(skeleton, mark.cell.row)
      const cb = columnBounds(skeleton, mark.cell.column)
      if (!rb || !cb) continue
      const colour = this.theme.colours[mark.colour % this.theme.colours.length] ?? 'currentColor'
      const [left, right] = cb
      const [top, bottom] = rb
      if (mark.locked) {
        ctx.globalAlpha = this.theme.lockAlpha
        ctx.fillStyle = colour
        ctx.fillRect(left, top, right - left, bottom - top)
        ctx.globalAlpha = 1
      }
      const w = this.theme.lineWidth
      ctx.strokeStyle = colour
      ctx.lineWidth = w
      ctx.strokeRect(left + w / 2, top + w / 2, right - left - w, bottom - top - w)
    }
    ctx.restore()
  }
}
