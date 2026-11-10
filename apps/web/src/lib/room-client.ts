// Client of the workbook room (spec §11; protocol: packages/shared/src/room-protocol.ts).
//
// Framework-agnostic: it knows nothing of React or Univer. The editor plugs
// in through a `RoomEditorAdapter` (apps/web/src/collab/univer-adapter.ts
// adapts Univer's command service) and listens through the callbacks.
//
// - Local mutations are sent as ops carrying the room seq they were made on;
//   they stay pending until acknowledged.
// - Remote ops are applied as a collaborator's, so they are never echoed back.
// - A rejected op means the room's state differs: every pending op is
//   dropped and the room's snapshot replaces the local state (`resync`).
// - While disconnected, resyncing or for a viewer, the grid is read-only;
//   the client reconnects by itself and catches up on the ops it missed.

import { FrameAssembler, ROOM_CLOSE, ROOM_LIMITS, ROOM_PROTOCOL_VERSION, isStructuralOp, toFrames } from '@naf-sheets/shared'
import type { RoomCell, RoomChunk, RoomLock, RoomMutation, RoomOp, RoomPeer, RoomServerMessage } from '@naf-sheets/shared'

/** The part of a WebSocket the client uses (browser and Workers sockets both fit). */
export interface RoomSocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(type: 'close', listener: (event: { code: number; reason: string }) => void): void
}

/** What the client needs from the editor. */
export interface RoomEditorAdapter {
  /** Calls `listener` with the mutations of each local change, in order. Returns an unsubscribe function. */
  onLocalOp(listener: (mutations: RoomMutation[]) => void): () => void
  /** Applies someone else's op (not echoed back). `structural`: rows, columns or sheets moved. */
  applyRemote(mutations: RoomMutation[], structural: boolean): void
  /** Replaces the whole workbook with the room's snapshot. */
  load(snapshot: Record<string, unknown>): Promise<void> | void
  /** False while disconnected, resyncing, or for a viewer. */
  setEditable(editable: boolean): void
}

export type RoomStatus =
  /** Opening the socket or waiting for the welcome. */
  | 'connecting'
  /** Joined: edits are shared. */
  | 'live'
  /** Loading the room's state after a rejected op or a server change. */
  | 'resyncing'
  /** Disconnected; read-only; reconnecting. */
  | 'offline'
  /** The room refused this client for good (old page, workbook gone, too large); see `message`. */
  | 'failed'
  /** `stop()` was called. */
  | 'stopped'

export interface RoomClientState {
  status: RoomStatus
  readOnly: boolean
  /** The room seq the local state includes (null before the first welcome). */
  seq: number | null
  /** Ops sent and not yet acknowledged. */
  pending: number
  /** Last committed snapshot version the room reported. */
  version: number | null
  connectionId: string | null
  /** Everyone else connected (this connection left out). */
  peers: RoomPeer[]
  /** Locks held by other connections. */
  locks: RoomLock[]
}

export interface RoomClientOptions {
  /** Opens a socket to GET /api/workbooks/:id/room; resolves once it is open. */
  connect(): Promise<RoomSocketLike>
  adapter: RoomEditorAdapter
  /** Stable for this editor session; default random. */
  clientId?: string
  /**
   * The committed version the editor already shows (GET /api/workbooks/:id).
   * Sent on the first join: a room holding exactly that version answers with
   * nothing to load, so the editor is not reloaded.
   */
  initialVersion?: number
  onState?(state: RoomClientState): void
  /** Arabic message for the user (an op refused, edits dropped, the room unavailable). */
  onNotice?(message: string, kind: 'rejected' | 'dropped' | 'failed' | 'lock_denied'): void
  /** Delays between reconnect attempts; the last one repeats. */
  reconnectDelaysMs?: readonly number[]
  /** Interval of keep-alive pings. */
  pingMs?: number
  /** Presence messages are sent at most this often. */
  presenceMs?: number
}

export const ROOM_CLIENT_DEFAULTS = {
  reconnectDelaysMs: [500, 1_000, 2_000, 5_000, 10_000],
  pingMs: 25_000,
  presenceMs: 100,
} as const

/** Arabic texts the client shows by itself (the room's own messages always win). */
export const ROOM_CLIENT_TEXT = {
  dropped: 'لم تصل آخر تعديلاتك إلى الخادم قبل إعادة تحميل الملف، فلم تُحفظ. راجع الخلايا وأعد تعديلها.',
  serverChange: 'حُدّث الملف من Basecamp أو من إعدادات الملف، فأُعيد تحميله بأحدث نسخة.',
  failed: 'تعذّر الاتصال اللحظي بالملف. أعد تحميل الصفحة، وإن تكرّر الخطأ فأبلغ مسؤول المنصة.',
} as const

interface Pending {
  opId: string
  baseSeq: number
  mutations: RoomMutation[]
  confirmedDeletions?: string[]
}

const FATAL_CLOSE: ReadonlySet<number> = new Set([ROOM_CLOSE.protocolMismatch, ROOM_CLOSE.unavailable, ROOM_CLOSE.badMessage, ROOM_CLOSE.refused])

function randomId(): string {
  return crypto.randomUUID()
}

/** The default socket factory in the browser: same origin, the session cookie authenticates. */
export function browserRoomSocket(workbookId: string): () => Promise<RoomSocketLike> {
  return () =>
    new Promise((resolve, reject) => {
      const location = (globalThis as { location?: { protocol: string; host: string } }).location
      if (!location) return reject(new Error('no location'))
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
      const socket = new WebSocket(`${scheme}://${location.host}/api/workbooks/${encodeURIComponent(workbookId)}/room`)
      const target = socket as unknown as { addEventListener(type: string, fn: () => void, options?: { once: boolean }): void }
      target.addEventListener('open', () => resolve(socket as unknown as RoomSocketLike), { once: true })
      target.addEventListener('error', () => reject(new Error('room socket failed')), { once: true })
    })
}

export class RoomClient {
  readonly clientId: string
  private readonly options: RoomClientOptions
  private readonly delays: readonly number[]
  private socket: RoomSocketLike | null = null
  private status: RoomStatus = 'connecting'
  private readOnly = false
  private seq: number | null = null
  private epoch = 1
  private version: number | null = null
  private connectionId: string | null = null
  private pending: Pending[] = []
  private peers: RoomPeer[] = []
  private locks: RoomLock[] = []
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private presenceTimer: ReturnType<typeof setTimeout> | null = null
  private presence: { cell: RoomCell | null } | null = null
  private unsubscribe: (() => void) | null = null
  /** Messages are handled one at a time: a resync may await the editor. */
  private inbox: Promise<void> = Promise.resolve()
  private opCounter = 0
  /** Deletions confirmed in the dialog, sent on the next op (the one that removes the rows). */
  private confirmations: string[] = []

  constructor(options: RoomClientOptions) {
    this.options = options
    this.clientId = options.clientId ?? `c-${randomId()}`
    this.delays = options.reconnectDelaysMs ?? ROOM_CLIENT_DEFAULTS.reconnectDelaysMs
  }

  /** Connects and keeps connecting until `stop()`. */
  start(): void {
    this.unsubscribe = this.options.adapter.onLocalOp((mutations) => this.local(mutations))
    this.setStatus('connecting')
    void this.open()
  }

  stop(): void {
    this.setStatus('stopped')
    this.unsubscribe?.()
    this.unsubscribe = null
    this.clearTimers()
    const socket = this.socket
    this.socket = null
    try {
      socket?.close(1000, 'stopped')
    } catch {
      // Already closed.
    }
  }

  state(): RoomClientState {
    return {
      status: this.status,
      readOnly: this.readOnly,
      seq: this.seq,
      pending: this.pending.length,
      version: this.version,
      connectionId: this.connectionId,
      peers: this.peers.filter((p) => p.connectionId !== this.connectionId),
      locks: this.locks.filter((l) => l.connectionId !== this.connectionId),
    }
  }

  /** The cell this user has selected (sent at most every `presenceMs`). */
  setSelection(cell: RoomCell | null): void {
    this.presence = { cell }
    if (this.presenceTimer !== null) return
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null
      if (this.presence && this.status === 'live') this.send({ type: 'presence', cell: this.presence.cell })
      this.presence = null
    }, this.options.presenceMs ?? ROOM_CLIENT_DEFAULTS.presenceMs)
  }

  /** True when another connection holds the soft lock on `cell` (the editor must not open it). */
  isLockedByOthers(cell: RoomCell): boolean {
    return this.locks.some((l) => l.connectionId !== this.connectionId && l.cell.sheetId === cell.sheetId && l.cell.row === cell.row && l.cell.column === cell.column)
  }

  /** Editing `cell` starts: ask for its soft lock. A refusal arrives as an `onNotice(…, 'lock_denied')`. */
  lockCell(cell: RoomCell): void {
    if (this.status === 'live' && !this.readOnly) this.send({ type: 'lock', cell })
  }

  /** Editing finished or was cancelled. Send after the edit's own op, so the lock covers it. */
  unlockCell(): void {
    if (this.status === 'live') this.send({ type: 'unlock' })
  }

  /**
   * The person confirmed the deletion of these synced rows (spec §9.2.7). They
   * travel on the next local op — the removal the dialog lets through — and
   * nowhere else; a resync drops them with the op.
   * OPEN: apps/api/OPEN_QUESTIONS.md R19.
   */
  confirmDeletions(uids: readonly string[]): void {
    for (const uid of uids) if (!this.confirmations.includes(uid)) this.confirmations.push(uid)
  }

  // ── Connection ────────────────────────────────────────────────────────────

  private async open(): Promise<void> {
    if (this.status === 'stopped' || this.status === 'failed') return
    let socket: RoomSocketLike
    try {
      socket = await this.options.connect()
    } catch {
      return this.retry()
    }
    // `stop()` may have run while connecting.
    if ((this.status as RoomStatus) === 'stopped') {
      socket.close(1000, 'stopped')
      return
    }
    this.socket = socket
    const assembler = new FrameAssembler(ROOM_LIMITS.maxMessageChars * 4)
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return
      let msg: RoomServerMessage
      try {
        msg = JSON.parse(String(event.data)) as RoomServerMessage
        if (msg.type === 'chunk') {
          const text = assembler.push(msg as RoomChunk)
          if (text === null) return
          msg = JSON.parse(text) as RoomServerMessage
        }
      } catch {
        socket.close(ROOM_CLOSE.badMessage, 'bad frame')
        return
      }
      this.inbox = this.inbox.then(() => this.handle(msg)).catch((error: unknown) => console.error('[room] message failed', error))
    })
    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return
      this.socket = null
      this.clearTimers()
      if (this.status === 'stopped' || this.status === 'failed') return
      if (FATAL_CLOSE.has(event.code)) {
        this.fail(ROOM_CLIENT_TEXT.failed)
        return
      }
      this.setStatus('offline')
      this.retry()
    })
    this.pingTimer = setInterval(() => this.sendRaw('{"type":"ping"}'), this.options.pingMs ?? ROOM_CLIENT_DEFAULTS.pingMs)
    const hello: Record<string, unknown> = { type: 'hello', protocol: ROOM_PROTOCOL_VERSION, clientId: this.clientId, seq: this.seq }
    if (this.seq === null && this.options.initialVersion !== undefined) hello.version = this.options.initialVersion
    this.send(hello)
  }

  private retry(): void {
    if (this.status === 'stopped' || this.status === 'failed') return
    if (this.status !== 'offline') this.setStatus('offline')
    const delay = this.delays[Math.min(this.attempt, this.delays.length - 1)] ?? 1_000
    this.attempt++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.open()
    }, delay)
  }

  private fail(message: string): void {
    this.setStatus('failed')
    this.options.onNotice?.(message, 'failed')
    const socket = this.socket
    this.socket = null
    this.clearTimers()
    try {
      socket?.close(1000, 'failed')
    } catch {
      // Already closed.
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
    if (this.pingTimer !== null) clearInterval(this.pingTimer)
    if (this.presenceTimer !== null) clearTimeout(this.presenceTimer)
    this.reconnectTimer = null
    this.pingTimer = null
    this.presenceTimer = null
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  private async handle(msg: RoomServerMessage): Promise<void> {
    if (this.status === 'stopped' || this.status === 'failed') return
    switch (msg.type) {
      case 'welcome': {
        this.attempt = 0
        this.connectionId = msg.connectionId
        this.readOnly = msg.readOnly
        this.epoch = msg.epoch
        this.version = msg.version
        this.peers = msg.peers
        this.locks = msg.locks
        if (msg.mode === 'snapshot') {
          if (this.pending.length > 0) this.options.onNotice?.(ROOM_CLIENT_TEXT.dropped, 'dropped')
          this.pending = []
          this.setStatus('resyncing')
          await this.options.adapter.load(msg.snapshot)
          this.seq = msg.seq
        } else {
          for (const op of msg.ops) this.remote(op)
          this.seq = msg.seq
          // Ops this client sent that never arrived are sent again, on their original base.
          for (const p of this.pending) this.sendOp(p)
        }
        this.setStatus('live')
        return
      }
      case 'ack':
        this.pending = this.pending.filter((p) => p.opId !== msg.opId)
        this.seq = Math.max(this.seq ?? 0, msg.seq)
        return this.emit()
      case 'op':
        if (this.status !== 'live') return
        this.remote(msg.op)
        return this.emit()
      case 'reject':
        if (msg.reason === 'stale_epoch') return
        this.options.onNotice?.(msg.message, 'rejected')
        this.pending = []
        this.confirmations = []
        this.setStatus('resyncing')
        return
      case 'resync':
        if (msg.reason === 'server_change' && this.pending.length > 0) this.options.onNotice?.(ROOM_CLIENT_TEXT.dropped, 'dropped')
        this.pending = []
        this.epoch = msg.epoch
        this.version = msg.version
        this.setStatus('resyncing')
        await this.options.adapter.load(msg.snapshot)
        this.seq = msg.seq
        this.setStatus('live')
        return
      case 'presence':
        this.peers = msg.peers
        return this.emit()
      case 'locks':
        this.locks = msg.locks
        return this.emit()
      case 'lock-denied':
        this.options.onNotice?.(msg.message, 'lock_denied')
        return
      case 'saved':
        this.version = msg.version
        return this.emit()
      case 'error':
        if (msg.code === 'not_joined') return
        this.fail(msg.message)
        return
      case 'pong':
      case 'chunk':
        return
    }
  }

  /** An op from the room: someone else's is applied; this client's own (seen on catch-up) acknowledges it. */
  private remote(op: RoomOp): void {
    if (op.origin.kind === 'user' && op.origin.clientId === this.clientId) {
      this.pending = this.pending.filter((p) => p.opId !== op.opId)
    } else {
      this.options.adapter.applyRemote(op.mutations, isStructuralOp(op.mutations))
    }
    this.seq = op.seq
  }

  private local(mutations: RoomMutation[]): void {
    if (mutations.length === 0) return
    if (this.status !== 'live' || this.readOnly || this.seq === null) {
      // The grid should have been read-only: the local state now differs from the room's.
      if (this.status === 'live') this.send({ type: 'resync' })
      return
    }
    for (let i = 0; i < mutations.length; i += ROOM_LIMITS.maxMutationsPerOp) {
      const op: Pending = { opId: `${this.clientId}-${++this.opCounter}`, baseSeq: this.seq, mutations: mutations.slice(i, i + ROOM_LIMITS.maxMutationsPerOp) }
      if (this.confirmations.length > 0) {
        op.confirmedDeletions = this.confirmations
        this.confirmations = []
      }
      this.pending.push(op)
      this.sendOp(op)
    }
    this.emit()
  }

  private sendOp(op: Pending): void {
    const msg: Record<string, unknown> = { type: 'op', opId: op.opId, baseSeq: op.baseSeq, epoch: this.epoch, mutations: op.mutations }
    if (op.confirmedDeletions) msg.confirmedDeletions = op.confirmedDeletions
    this.send(msg)
  }

  private send(msg: Record<string, unknown>): void {
    for (const frame of toFrames(JSON.stringify(msg), randomId())) this.sendRaw(frame)
  }

  private sendRaw(frame: string): void {
    try {
      this.socket?.send(frame)
    } catch {
      // Closing; the close handler reconnects.
    }
  }

  private setStatus(status: RoomStatus): void {
    this.status = status
    this.options.adapter.setEditable(status === 'live' && !this.readOnly)
    this.emit()
  }

  private emit(): void {
    this.options.onState?.(this.state())
  }
}
