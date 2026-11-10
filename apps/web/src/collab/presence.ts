// Pure helpers for showing who is in the workbook (spec §11: avatars at the
// top of the file, a coloured frame around the cell each person edits).
// No colour values here: a peer gets an index into the theme's presence
// colours (`--presence-1` … `--presence-6`, src/styles/theme.css).
// OPEN: how presence is shown in the grid (apps/web/OPEN_QUESTIONS.md #53).

import type { RoomCell, RoomLock, RoomPeer } from '@naf-sheets/shared'

/** How many presence colours the theme defines. */
export const PRESENCE_COLOURS = 6

/** A stable colour index for a connection (the same person in two tabs may differ). */
export function presenceColour(connectionId: string): number {
  let h = 0
  for (let i = 0; i < connectionId.length; i++) h = (h * 31 + connectionId.charCodeAt(i)) >>> 0
  return h % PRESENCE_COLOURS
}

/** Initials for an avatar: the first letters of the first two words, or '؟'. */
export function initials(name: string | null): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '؟'
  return words
    .slice(0, 2)
    .map((w) => [...w][0] ?? '')
    .join('')
}

export interface CellMark {
  cell: RoomCell
  connectionId: string
  userId: string
  name: string | null
  colour: number
  /** True when this person is editing the cell (soft lock): others may not edit it. */
  locked: boolean
}

/** Frames to draw on the sheet shown now: one per other person's selected or locked cell there. */
export function cellMarks(peers: readonly RoomPeer[], locks: readonly RoomLock[], sheetId: string): CellMark[] {
  const byConnection = new Map(peers.map((p) => [p.connectionId, p]))
  const marks = new Map<string, CellMark>()
  for (const p of peers) {
    if (p.cell && p.cell.sheetId === sheetId) {
      marks.set(p.connectionId, { cell: p.cell, connectionId: p.connectionId, userId: p.userId, name: p.name, colour: presenceColour(p.connectionId), locked: false })
    }
  }
  for (const l of locks) {
    if (l.cell.sheetId !== sheetId) continue
    const p = byConnection.get(l.connectionId)
    marks.set(l.connectionId, { cell: l.cell, connectionId: l.connectionId, userId: l.userId, name: p?.name ?? null, colour: presenceColour(l.connectionId), locked: true })
  }
  return [...marks.values()]
}
