// One editor's realtime session (spec §11): the room client, the Univer
// adapter, and the bridge to whichever editor instance is mounted now. A
// resync replaces the whole workbook, which the editor does by mounting a new
// Univer instance with the room's snapshot; the session (connection, seq,
// pending ops) survives that, so it lives above the mounted editor.
//
// Modes:
// - connecting / live / resyncing / offline / failed: the room client's own
//   states. Only `live` (and not a viewer) lets the grid take edits.
// - unavailable: the room could not be joined at all (no welcome on the first
//   connection: the socket failed or timed out). The editor then falls back to
//   saving whole snapshots (PUT …/snapshot), as before phase 6; the API refuses
//   such a save while anyone else is in the room (409 `room_active`), so the
//   fallback can never overwrite live edits.
//   OPEN: apps/web/OPEN_QUESTIONS.md #50.

import type { RoomCell, RoomLock, RoomPeer } from '@naf-sheets/shared'
import { RoomClient, browserRoomSocket } from '../lib/room-client'
import type { RoomClientState, RoomSocketLike } from '../lib/room-client'
import { cellMarks } from './presence'
import type { CellMark } from './presence'
import { createUniverRoomAdapter } from './univer-adapter'
import type { CollabCommandService, UniverRoomAdapter } from './univer-adapter'

export type CollabMode = 'connecting' | 'live' | 'resyncing' | 'offline' | 'failed' | 'unavailable'

export interface CollabView {
  mode: CollabMode
  /** A viewer: the room refuses every edit. */
  readOnly: boolean
  /** Edits sent and not yet acknowledged. */
  pending: number
  /** Everyone else connected. */
  peers: RoomPeer[]
  /** Cells other people are editing. */
  locks: RoomLock[]
}

/** What the session needs from a mounted editor (src/editor/univer-host.ts `MountedWorkbook`). */
export interface CollabMount {
  readonly collab: { commands: CollabCommandService; clearUndo(): void }
}

export type CollabNoticeKind = 'rejected' | 'dropped' | 'failed' | 'lock_denied'

export interface CollabSessionOptions {
  workbookId: string
  /** The committed version the editor mounted (GET /api/workbooks/:id). */
  version: number
  /** Default: the platform's own WebSocket route (cookie authentication). */
  connect?: () => Promise<RoomSocketLike>
  /** Mount a new editor instance with `snapshot`; the new instance calls `attach` when ready. */
  reload(snapshot: Record<string, unknown>): void
  /** Arabic message for the user. */
  onNotice?(message: string, kind: CollabNoticeKind): void
  /** No welcome within this long on the first connection: the room is unavailable. */
  joinTimeoutMs?: number
}

const JOIN_TIMEOUT_MS = 10_000

export class CollabSession {
  private readonly client: RoomClient
  private readonly adapter: UniverRoomAdapter
  private readonly options: CollabSessionOptions
  private mount: CollabMount | null = null
  private pendingLoad: (() => void) | null = null
  private everLive = false
  private unavailable = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private current: CollabView = { mode: 'connecting', readOnly: false, pending: 0, peers: [], locks: [] }
  private readonly listeners = new Set<(view: CollabView) => void>()

  constructor(options: CollabSessionOptions) {
    this.options = options
    this.adapter = createUniverRoomAdapter({
      unitId: options.workbookId,
      commands: () => this.mount?.collab.commands ?? null,
      load: (snapshot) =>
        new Promise<void>((resolve) => {
          this.pendingLoad = resolve
          options.reload(snapshot)
        }),
      // The grid's editability is derived from `view()` by the editor, with its other rules.
      setEditable: () => undefined,
      clearUndo: () => this.mount?.collab.clearUndo(),
    })
    this.client = new RoomClient({
      adapter: this.adapter,
      connect: options.connect ?? browserRoomSocket(options.workbookId),
      initialVersion: options.version,
      onState: (state) => this.onState(state),
      onNotice: (message, kind) => options.onNotice?.(message, kind),
    })
  }

  start(): void {
    this.client.start()
    this.timer = setTimeout(() => this.giveUp(), this.options.joinTimeoutMs ?? JOIN_TIMEOUT_MS)
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.client.stop()
    this.adapter.dispose()
    this.listeners.clear()
  }

  view(): CollabView {
    return this.current
  }

  subscribe(listener: (view: CollabView) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** True when the grid may take edits as far as the room is concerned. */
  allowsEdits(): boolean {
    return (this.current.mode === 'live' && !this.current.readOnly) || this.current.mode === 'unavailable'
  }

  /** Edits are shared through the room (not saved with PUT). */
  get shared(): boolean {
    return this.current.mode !== 'unavailable'
  }

  // ── The mounted editor ───────────────────────────────────────────────────

  /** A mounted editor is ready: local edits are read from it, remote ones applied to it. */
  attach(mount: CollabMount): void {
    this.mount = mount
    this.adapter.rebind()
    const done = this.pendingLoad
    this.pendingLoad = null
    done?.()
  }

  detach(mount: CollabMount): void {
    if (this.mount !== mount) return
    this.mount = null
    this.adapter.rebind()
  }

  // ── Presence and locks ───────────────────────────────────────────────────

  setSelection(cell: RoomCell | null): void {
    if (this.shared) this.client.setSelection(cell)
  }

  isLockedByOthers(cell: RoomCell): boolean {
    return this.shared && this.client.isLockedByOthers(cell)
  }

  /** Who holds the lock on `cell`, for the message. */
  lockHolder(cell: RoomCell): RoomPeer | null {
    const lock = this.current.locks.find((l) => l.cell.sheetId === cell.sheetId && l.cell.row === cell.row && l.cell.column === cell.column)
    return lock ? (this.current.peers.find((p) => p.connectionId === lock.connectionId) ?? null) : null
  }

  lockCell(cell: RoomCell): void {
    if (this.shared) this.client.lockCell(cell)
  }

  unlockCell(): void {
    if (this.shared) this.client.unlockCell()
  }

  /** Synced rows confirmed in the deletion dialog: sent on the op that removes them (spec §9.2.7). */
  confirmDeletions(uids: readonly string[]): void {
    if (this.shared) this.client.confirmDeletions(uids)
  }

  marks(sheetId: string): CellMark[] {
    return cellMarks(this.current.peers, this.current.locks, sheetId)
  }

  // ── State ────────────────────────────────────────────────────────────────

  private onState(state: RoomClientState): void {
    if (this.unavailable || state.status === 'stopped') return
    if (state.status === 'live' && !this.everLive) {
      this.everLive = true
      if (this.timer !== null) clearTimeout(this.timer)
      this.timer = null
    }
    // Never joined: the room is not there. Fall back instead of waiting read-only.
    if (!this.everLive && (state.status === 'offline' || state.status === 'failed')) return this.giveUp()
    this.set({ mode: state.status, readOnly: state.readOnly, pending: state.pending, peers: state.peers, locks: state.locks })
  }

  private giveUp(): void {
    if (this.everLive || this.unavailable) return
    this.unavailable = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.client.stop()
    this.set({ mode: 'unavailable', readOnly: false, pending: 0, peers: [], locks: [] })
  }

  private set(view: CollabView): void {
    this.current = view
    for (const l of this.listeners) l(view)
  }
}
