// The grid side of realtime collaboration, on one mounted workbook:
// - the frames around other people's cells (presence-render.ts);
// - this person's selected cell, sent as presence;
// - soft locks (spec §11): opening the cell editor asks for the cell's lock,
//   closing it releases the lock; a cell someone else is editing does not open.
// Everything goes through the public Facade events.

import type { RoomCell } from '@naf-sheets/shared'
import type { MountedWorkbook } from '../editor/univer-host'
import { PresenceExtension, readPresenceTheme } from './presence-render'
import type { CollabSession } from './session'
import { collabText } from './strings'

type EditEvent = { workbook: { getId(): string }; worksheet: { getSheetId(): string }; row: number; column: number; cancel?: boolean }

export interface CollabGridOptions {
  /** A cell someone else is editing was not opened: tell the person (Arabic). */
  onLocked(message: string): void
}

export function installCollabGrid(mounted: MountedWorkbook, session: CollabSession, options: CollabGridOptions): () => void {
  const { univerAPI, workbook } = mounted.facade
  const unitId = mounted.unitId
  const disposers: Array<() => void> = []
  const on = <T>(event: string | undefined, handler: (e: T) => void) => {
    if (!event) return
    const d = (univerAPI.addEvent as unknown as (e: string, h: (e: T) => void) => { dispose(): void })(event, handler)
    disposers.push(() => d.dispose())
  }
  const events = univerAPI.Event as unknown as Record<string, string>

  // Frames.
  const extended = univerAPI as unknown as { registerSheetMainExtension?: (unitId: string, ...ext: unknown[]) => { dispose(): void } }
  try {
    const registered = extended.registerSheetMainExtension?.(unitId, new PresenceExtension((sheetId) => session.marks(sheetId), readPresenceTheme()))
    if (registered) disposers.push(() => registered.dispose())
  } catch (error) {
    console.error('[collab] could not register the presence frames', error)
  }
  const redraw = () => {
    try {
      workbook.getActiveSheet().refreshCanvas()
    } catch {
      // Nothing drawn yet.
    }
  }
  let lastMarks = ''
  disposers.push(
    session.subscribe((view) => {
      const key = JSON.stringify([view.peers.map((p) => [p.connectionId, p.cell]), view.locks])
      if (key === lastMarks) return
      lastMarks = key
      redraw()
    }),
  )

  // Presence: the selected cell.
  const currentCell = (): RoomCell | null => {
    try {
      const sheet = workbook.getActiveSheet()
      const cell = sheet.getSelection()?.getCurrentCell()
      return cell ? { sheetId: sheet.getSheetId(), row: cell.actualRow, column: cell.actualColumn } : null
    } catch {
      return null
    }
  }
  on<unknown>(events.SelectionChanged, () => session.setSelection(currentCell()))
  on<unknown>(events.ActiveSheetChanged, () => session.setSelection(currentCell()))

  // Soft locks.
  const cellOf = (e: EditEvent): RoomCell | null => (e.workbook.getId() === unitId ? { sheetId: e.worksheet.getSheetId(), row: e.row, column: e.column } : null)
  on<EditEvent>(events.BeforeSheetEditStart, (e) => {
    const cell = cellOf(e)
    if (!cell || !session.isLockedByOthers(cell)) return
    e.cancel = true
    options.onLocked(collabText.lockedBy(session.lockHolder(cell)?.name ?? null))
  })
  on<EditEvent>(events.SheetEditStarted, (e) => {
    const cell = cellOf(e)
    if (cell) session.lockCell(cell)
  })
  on<EditEvent>(events.SheetEditEnded, (e) => {
    if (!cellOf(e)) return
    // After the edit's own op, which is sent at the end of this task.
    setTimeout(() => session.unlockCell(), 0)
  })

  return () => {
    for (const d of disposers.reverse()) {
      try {
        d()
      } catch (error) {
        console.error('[collab] dispose failed', error)
      }
    }
  }
}
