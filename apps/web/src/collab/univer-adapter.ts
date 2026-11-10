// Adapts a Univer 1.4.0 workbook to the room client (lib/room-client.ts).
//
// Local changes are read from `ICommandService.onMutationExecutedForCollab`,
// Univer's own hook for collaboration: it reports every mutation, including
// the `syncOnly` ones a large sheet copy emits, and the adapter keeps those
// that are this user's changes to this workbook (not `onlyLocal` — formula
// results, layout — and not applied from a collaborator). The mutations of
// one Univer command run synchronously, so everything reported in one
// JavaScript task is one op.
//
// Remote ops are applied with `{ fromCollab: true }`: Univer runs them like
// any mutation (formulas recompute), the editor's autosave ignores them
// (apps/web/src/editor/workbook-data.ts `isPersistentChange`), and this
// adapter does not send them back.
//
// No runtime import from Univer: the host passes the services in, so this
// file is unit-tested without Univer and stays usable with any mount code.

import type { RoomMutation } from '@naf-sheets/shared'
import type { RoomEditorAdapter } from '../lib/room-client'

/** The slice of Univer's `ICommandService` the adapter uses. */
export interface CollabCommandService {
  onMutationExecutedForCollab(
    listener: (info: { id: string; type?: number; params?: unknown }, options?: { onlyLocal?: boolean; fromCollab?: boolean; fromChangeset?: boolean; syncOnly?: boolean }) => void,
  ): { dispose(): void }
  syncExecuteCommand(id: string, params?: object, options?: { fromCollab?: boolean }): unknown
}

export interface UniverCollabHost {
  /** The Univer unit id of the workbook (the snapshot's `id`). */
  unitId: string
  /**
   * The command service of the Univer instance showing the workbook now, or
   * null while none is mounted (before the room's first snapshot). It may
   * change after `load`.
   */
  commands(): CollabCommandService | null
  /** Replace the workbook with `snapshot` (remount, or dispose the unit and create it again). */
  load(snapshot: Record<string, unknown>): Promise<void> | void
  setEditable(editable: boolean): void
  /**
   * Forget local undo/redo history. Called when a remote op moved rows,
   * columns or sheets: undoing an older local change afterwards would hit the
   * wrong cells. With `IUndoRedoService.clearUndoRedo(unitId)`.
   */
  clearUndo?(): void
}

/** CommandType.MUTATION in @univerjs/core 1.4.0. */
const MUTATION = 2

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export interface UniverRoomAdapter extends RoomEditorAdapter {
  /** Subscribe again to `host.commands()` (call when a workbook was mounted outside `load`). */
  rebind(): void
  dispose(): void
}

export function createUniverRoomAdapter(host: UniverCollabHost): UniverRoomAdapter {
  const listeners = new Set<(mutations: RoomMutation[]) => void>()
  let batch: RoomMutation[] = []
  let scheduled = false
  let applyingRemote = false
  let subscription: { dispose(): void } | null = null

  const flush = () => {
    scheduled = false
    const out = batch
    batch = []
    if (out.length > 0) for (const l of listeners) l(out)
  }

  const subscribe = () => {
    subscription?.dispose()
    subscription = null
    const commands = host.commands()
    if (!commands) return
    subscription = commands.onMutationExecutedForCollab((info, options) => {
      if (applyingRemote) return
      if (info.type !== undefined && info.type !== MUTATION) return
      if (options?.onlyLocal || options?.fromCollab || options?.fromChangeset) return
      if (!isObject(info.params) || info.params.unitId !== host.unitId) return
      // A copy: Univer keeps and may later change what it executed.
      batch.push({ id: info.id, params: structuredClone(info.params) })
      if (!scheduled) {
        scheduled = true
        // After the command's whole synchronous run, before any other task.
        queueMicrotask(flush)
      }
    })
  }
  subscribe()

  return {
    onLocalOp(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    applyRemote(mutations, structural) {
      const commands = host.commands()
      if (!commands) throw new Error('room adapter: no workbook mounted to apply a remote op to')
      applyingRemote = true
      try {
        for (const m of mutations) commands.syncExecuteCommand(m.id, structuredClone(m.params), { fromCollab: true })
      } finally {
        applyingRemote = false
      }
      // OPEN: undo history survives remote cell edits (apps/api/OPEN_QUESTIONS.md R10).
      if (structural) host.clearUndo?.()
    },
    async load(snapshot) {
      // Local changes still batched belong to the state being replaced.
      batch = []
      subscription?.dispose()
      subscription = null
      await host.load(snapshot)
      subscribe()
    },
    setEditable(editable) {
      host.setEditable(editable)
    },
    rebind() {
      batch = []
      subscribe()
    },
    dispose() {
      subscription?.dispose()
      subscription = null
      listeners.clear()
    },
  }
}
