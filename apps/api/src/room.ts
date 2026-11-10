// WorkbookRoom — one Durable Object per workbook (spec §4.2, §11), realtime
// collaboration by default (a) of spec §5.3 until §17-2 is decided: the room
// is the source of truth while a session is live; it orders the editors'
// Univer mutations, applies them to its own headless Univer, broadcasts them,
// keeps presence and soft cell locks, and commits the workbook snapshot.
// Protocol: packages/shared/src/room-protocol.ts.
//
// The Worker is the only way in: a Durable Object has no public address, so
// the identity headers below can only have been set by the Worker after
// `loadWorkbook` resolved the caller's access (spec §14: checked on every
// request and every WebSocket connection).
//
// State: the last committed snapshot (R2 + D1) plus the room's op log
// (room/store.ts, Durable Object SQLite). The headless Univer is a cache
// rebuilt from them after hibernation or a restart. Every change to the state
// runs through `exclusive`, one at a time, in arrival order.

import { DurableObject } from 'cloudflare:workers'
import {
  FrameAssembler,
  ROOM_CLOSE,
  ROOM_LIMITS,
  ROOM_PROTOCOL_VERSION,
  toFrames,
} from '@naf-sheets/shared'
import type {
  RoomCell,
  RoomClientMessage,
  RoomErrorCode,
  RoomHello,
  RoomLock,
  RoomMutation,
  RoomOp,
  RoomOpMessage,
  RoomPeer,
  RoomRejectReason,
  RoomResync,
  RoomServerMessage,
} from '@naf-sheets/shared'
import type { WorkbookAccess } from './access'
import { canWrite } from './access'
import type { Env } from './env'
import { errorResponse } from './errors'
import type { HeadlessWorkbook } from './room/engine'
import { STRUCTURAL, classifyOp, footprintTouchesCell, footprintsConflict } from './room/footprint'
import type { Footprint } from './room/footprint'
import { ERROR_MESSAGES, LOCK_DENIED_MESSAGE, LOCK_FORBIDDEN_MESSAGE, REJECT_MESSAGES } from './room/messages'
import { outboundDetection } from './room/outbound-seam'
import { commitOnTop, currentVersion, readSnapshotText } from './room/persist'
import { cellMutations, cellSpans, cellsMatch, planServerChange } from './room/server-change'
import { directUpdate } from './room/direct-write'
import { RoomStore } from './room/store'
import type { LogEntry } from './room/store'
import { DEFAULT_SNAPSHOT_ORPHAN_AGE_MS } from './snapshot'

export const ROOM_HEADERS = {
  workbook: 'x-naf-room-workbook',
  user: 'x-naf-room-user',
  access: 'x-naf-room-access',
} as const

const ACCESS_VALUES: ReadonlySet<string> = new Set<WorkbookAccess>(['admin', 'owner', 'editor', 'viewer'])

/** The request forwarded to the room, carrying the identity the Worker verified. */
export function roomRequest(original: Request, identity: { workbookId: string; userId: string; access: WorkbookAccess }): Request {
  const headers = new Headers(original.headers)
  // The room never needs the session cookie.
  headers.delete('cookie')
  headers.set(ROOM_HEADERS.workbook, identity.workbookId)
  headers.set(ROOM_HEADERS.user, identity.userId)
  headers.set(ROOM_HEADERS.access, identity.access)
  return new Request(original.url, { method: 'GET', headers })
}

/** True while editors are connected to the workbook's room (for routes that must not write behind its back). */
export async function roomSessionActive(env: Env, workbookId: string): Promise<boolean> {
  return env.WORKBOOK_ROOM.get(env.WORKBOOK_ROOM.idFromName(workbookId)).isLive()
}

// ── Tunables ────────────────────────────────────────────────────────────────

// OPEN: persistence cadence (apps/api/OPEN_QUESTIONS.md R3). 2 s after the
// last edit, as the outbound debounce of spec §9.2.2, and at most 10 s while
// edits keep coming, as the editor's autosave.
export const PERSIST_DEBOUNCE_MS = 2_000
export const PERSIST_MAX_WAIT_MS = 10_000
const PERSIST_RETRY_MS = 5_000
/** Ops kept in memory for conflict checks; an op based further back is refused as a conflict. */
const CONFLICT_WINDOW = 1_000
/** Above this many missed ops a reconnecting client gets the snapshot instead. */
const CATCHUP_MAX = 1_000
// OPEN: the largest workbook the room opens live (apps/api/OPEN_QUESTIONS.md R5).
// Measured: a 10,000-row workbook is ~3 MB of JSON and ~67 MB of heap after GC.
export const MAX_LIVE_SNAPSHOT_CHARS = 4_000_000

// ── Types ───────────────────────────────────────────────────────────────────

/** Per connection, kept by the runtime across hibernation (`serializeAttachment`, ≤ 2 KiB). */
interface Attachment {
  connectionId: string
  workbookId: string
  userId: string
  access: WorkbookAccess
  name: string | null
  clientId: string | null
  joined: boolean
  epoch: number
  cell: RoomCell | null
  lock: RoomCell | null
}

interface Recent {
  seq: number
  clientId: string | null
  opId: string | null
  footprint: Footprint
}

interface Live {
  workbookId: string
  engine: HeadlessWorkbook
  seq: number
  version: number
  persistedSeq: number
  recent: Recent[]
  lastAuthor: string
  dirtySince: number | null
}

export interface ServerChangeRequest {
  workbookId: string
  savedBy: string
  attempts: number
  orphanAgeMs: number
}

/** What the caller's `change` answers across RPC: its snapshot only (the result stays with the caller). */
export type RemoteChangeResult = { ok: true; snapshot: unknown | null } | { ok: false }
export type RemoteChange = (snapshot: unknown, version: number) => Promise<RemoteChangeResult>

export type ServerChangeOutcome =
  | { status: 'written'; version: number }
  | { status: 'unchanged'; version: number }
  | { status: 'not_found' }
  | { status: 'contended' }
  /** The caller's `change` threw; the caller rethrows its own error. */
  | { status: 'change_failed' }

class RoomUnavailable extends Error {}
class RoomRefused extends Error {}
class ChangeFailed extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const CLIENT_ID = /^[A-Za-z0-9_-]{8,100}$/

function parseCell(v: unknown): RoomCell | null {
  if (!isObject(v)) return null
  const { sheetId, row, column } = v
  if (typeof sheetId !== 'string' || sheetId === '' || sheetId.length > 128 || !isCount(row) || !isCount(column)) return null
  return { sheetId, row, column }
}

/** A client frame, validated; null when malformed. */
export function parseClientMessage(text: string): RoomClientMessage | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObject(v) || typeof v.type !== 'string') return null
  switch (v.type) {
    case 'hello':
      if (typeof v.protocol !== 'number' || typeof v.clientId !== 'string' || !CLIENT_ID.test(v.clientId)) return null
      if (v.seq !== null && !isCount(v.seq)) return null
      return { type: 'hello', protocol: v.protocol, clientId: v.clientId, seq: v.seq as number | null }
    case 'op': {
      if (typeof v.opId !== 'string' || v.opId === '' || v.opId.length > 100 || !isCount(v.baseSeq) || !isCount(v.epoch)) return null
      if (!Array.isArray(v.mutations) || v.mutations.length === 0 || v.mutations.length > ROOM_LIMITS.maxMutationsPerOp) return null
      const mutations: RoomMutation[] = []
      for (const m of v.mutations) {
        if (!isObject(m) || typeof m.id !== 'string' || m.id.length > 200 || !isObject(m.params)) return null
        mutations.push({ id: m.id, params: m.params })
      }
      return { type: 'op', opId: v.opId, baseSeq: v.baseSeq, epoch: v.epoch, mutations }
    }
    case 'presence': {
      if (v.cell === null) return { type: 'presence', cell: null }
      const cell = parseCell(v.cell)
      return cell ? { type: 'presence', cell } : null
    }
    case 'lock': {
      const cell = parseCell(v.cell)
      return cell ? { type: 'lock', cell } : null
    }
    case 'unlock':
      return { type: 'unlock' }
    case 'resync':
      return { type: 'resync' }
    case 'ping':
      return { type: 'ping' }
    case 'chunk':
      if (typeof v.id !== 'string' || v.id.length > 100 || !isCount(v.index) || !isCount(v.count) || typeof v.data !== 'string') return null
      return { type: 'chunk', id: v.id, index: v.index, count: v.count, data: v.data }
    default:
      return null
  }
}

const CLOSE_FOR: Record<RoomErrorCode, number | null> = {
  protocol_mismatch: ROOM_CLOSE.protocolMismatch,
  unavailable: ROOM_CLOSE.unavailable,
  bad_message: ROOM_CLOSE.badMessage,
  refused: ROOM_CLOSE.refused,
  not_joined: null,
}

// ── The room ────────────────────────────────────────────────────────────────

export class WorkbookRoom extends DurableObject<Env> {
  private readonly store: RoomStore
  private live: Live | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private readonly assemblers = new WeakMap<WebSocket, FrameAssembler>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.store = new RoomStore(ctx.storage.sql)
    // Keep-alive pings are answered without waking a hibernated room.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'))
  }

  override async fetch(request: Request): Promise<Response> {
    if ((request.headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') {
      return errorResponse(426, 'websocket_required')
    }

    const workbookId = request.headers.get(ROOM_HEADERS.workbook)
    const userId = request.headers.get(ROOM_HEADERS.user)
    const access = request.headers.get(ROOM_HEADERS.access)
    if (!workbookId || !userId || !access || !ACCESS_VALUES.has(access)) {
      return errorResponse(403, 'room_forbidden')
    }

    // OPEN: access is fixed for the connection's life; a role change applies
    // from the next connection (apps/api/OPEN_QUESTIONS.md R12).
    let name: string | null = null
    try {
      const row = await this.env.DB.prepare('SELECT display_name AS name FROM members WHERE user_id = ?1').bind(userId).first<{ name: string | null }>()
      name = row?.name ? row.name.slice(0, 100) : null
    } catch (error) {
      console.error('[room] could not read the member name', error instanceof Error ? error.name : 'unknown')
    }

    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    // Hibernation API; the tags find a user's sockets and their access.
    this.ctx.acceptWebSocket(server, [`user:${userId}`, `access:${access}`])
    const attachment: Attachment = {
      connectionId: crypto.randomUUID(),
      workbookId,
      userId,
      access: access as WorkbookAccess,
      name,
      clientId: null,
      joined: false,
      epoch: 1,
      cell: null,
      lock: null,
    }
    server.serializeAttachment(attachment)
    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return this.fail(ws, 'bad_message')
    let msg = parseClientMessage(message)
    if (msg?.type === 'chunk') {
      let assembler = this.assemblers.get(ws)
      if (!assembler) this.assemblers.set(ws, (assembler = new FrameAssembler(ROOM_LIMITS.maxMessageChars)))
      let text: string | null
      try {
        text = assembler.push(msg)
      } catch {
        return this.fail(ws, 'bad_message')
      }
      if (text === null) return
      msg = parseClientMessage(text)
      if (msg?.type === 'chunk') msg = null
    }
    if (!msg) return this.fail(ws, 'bad_message')

    const att = attachmentOf(ws)
    if (!att) return this.fail(ws, 'bad_message')
    if (msg.type === 'ping') return this.send(ws, { type: 'pong' })
    if (msg.type === 'hello') return this.exclusive(() => this.join(ws, msg))
    if (!att.joined) return this.send(ws, { type: 'error', code: 'not_joined', message: ERROR_MESSAGES.not_joined })

    switch (msg.type) {
      case 'op':
        return this.exclusive(() => this.applyOp(ws, msg))
      case 'presence':
        att.cell = msg.cell
        ws.serializeAttachment(att)
        return this.broadcastPresence()
      case 'lock':
        return this.lock(ws, att, msg.cell)
      case 'unlock':
        if (att.lock === null) return
        att.lock = null
        ws.serializeAttachment(att)
        return this.broadcastLocks()
      case 'resync':
        return this.exclusive(async () => this.resync(ws, await this.ensureLive(att.workbookId), 'requested'))
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason)
    } catch {
      // Already closed by the runtime.
    }
    await this.departed(ws)
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.departed(ws)
  }

  override async alarm(): Promise<void> {
    await this.exclusive(async () => {
      if (!this.live) {
        const meta = this.store.meta()
        if (!meta || meta.seq === meta.persistedSeq) return
        try {
          await this.ensureLive(meta.workbookId)
        } catch (error) {
          console.error('[room] alarm could not load the room', error instanceof Error ? error.message : 'unknown')
          return
        }
      }
      const result = await this.persist()
      if (result === 'busy') await this.ctx.storage.setAlarm(Date.now() + PERSIST_RETRY_MS)
      else if (result === 'gone') this.closeAll()
      else this.releaseIfIdle()
    })
  }

  // ── RPC ──────────────────────────────────────────────────────────────────

  /** True while at least one editor has joined. */
  async isLive(): Promise<boolean> {
    return this.joinedSockets().length > 0
  }

  /**
   * A server change (updateLatestSnapshot). With a live session it runs on
   * the room's state, is committed, applied and broadcast; without one, the
   * direct path runs here, inside the room's lock, so no session can start
   * halfway through it. Never call it from inside the room (it would wait on itself).
   */
  async serverChange(request: ServerChangeRequest, change: RemoteChange): Promise<ServerChangeOutcome> {
    try {
      return await this.exclusive(async () => {
        const meta = this.store.meta()
        const unpersisted = this.live ? this.live.seq !== this.live.persistedSeq : meta !== null && meta.workbookId === request.workbookId && meta.seq !== meta.persistedSeq
        if (this.joinedSockets().length === 0 && !unpersisted) {
          this.releaseIfIdle()
          return this.directServerChange(request, change)
        }
        return this.liveServerChange(request, change)
      })
    } finally {
      ;(change as unknown as Partial<Disposable>)[Symbol.dispose]?.()
    }
  }

  // ── Session ──────────────────────────────────────────────────────────────

  private async join(ws: WebSocket, hello: RoomHello): Promise<void> {
    const att = attachmentOf(ws)
    if (!att) return
    if (att.joined) return this.fail(ws, 'bad_message')
    if (hello.protocol !== ROOM_PROTOCOL_VERSION) return this.fail(ws, 'protocol_mismatch')

    let live: Live
    try {
      live = await this.ensureLive(att.workbookId)
    } catch (error) {
      if (error instanceof RoomRefused) return this.fail(ws, 'refused')
      if (!(error instanceof RoomUnavailable)) console.error('[room] could not open the room', error instanceof Error ? error.message : 'unknown')
      return this.fail(ws, 'unavailable')
    }

    att.clientId = hello.clientId
    att.joined = true
    att.epoch = 1
    ws.serializeAttachment(att)

    const base = {
      type: 'welcome' as const,
      protocol: ROOM_PROTOCOL_VERSION,
      connectionId: att.connectionId,
      userId: att.userId,
      readOnly: !canWrite(att.access),
      epoch: att.epoch,
      seq: live.seq,
      version: live.version,
      peers: this.peers(),
      locks: this.locks(),
    }
    const catchup = this.catchup(live, hello.seq)
    if (catchup) this.send(ws, { ...base, mode: 'catchup', ops: catchup })
    else this.send(ws, { ...base, mode: 'snapshot', snapshot: live.engine.snapshot() })
    // Everyone else learns about the newcomer (its welcome already lists them all).
    this.broadcast({ type: 'presence', peers: this.peers() }, ws)
  }

  /** The ops after `since`, when all are still in the log and none is a reset. */
  private catchup(live: Live, since: number | null): RoomOp[] | null {
    if (since === null || since > live.seq || live.seq - since > CATCHUP_MAX) return null
    const entries = this.store.range(since, live.seq)
    if (entries.length !== live.seq - since || entries.some((e) => e.kind !== 'op')) return null
    return entries.map(toRoomOp)
  }

  private async applyOp(ws: WebSocket, msg: RoomOpMessage): Promise<void> {
    const att = attachmentOf(ws)
    if (!att?.joined || att.clientId === null) return
    let live: Live
    try {
      live = await this.ensureLive(att.workbookId)
    } catch (error) {
      if (!(error instanceof RoomUnavailable)) console.error('[room] could not load the room', error instanceof Error ? error.message : 'unknown')
      return this.fail(ws, 'unavailable')
    }
    const reject = (reason: RoomRejectReason) => {
      this.send(ws, { type: 'reject', opId: msg.opId, reason, message: REJECT_MESSAGES[reason] })
      if (reason !== 'stale_epoch') this.resync(ws, live, 'rejected')
    }

    if (!canWrite(att.access)) return reject('forbidden')
    if (msg.epoch !== att.epoch) return reject('stale_epoch')
    const done = live.recent.find((e) => e.clientId === att.clientId && e.opId === msg.opId)
    if (done) return this.send(ws, { type: 'ack', opId: msg.opId, seq: done.seq })
    if (msg.baseSeq > live.seq) return reject('invalid')

    const classified = classifyOp(msg.mutations, live.engine.unitId)
    if (!classified.ok) return reject('invalid')
    const footprint = classified.footprint

    if (live.seq - msg.baseSeq > CONFLICT_WINDOW) return reject('conflict')
    const concurrent = live.recent.filter((e) => e.seq > msg.baseSeq && e.clientId !== att.clientId)
    if (concurrent.some((e) => footprintsConflict(e.footprint, footprint))) return reject('conflict')

    // OPEN: the soft lock is enforced here — an op touching a cell someone
    // else is editing is refused (apps/api/OPEN_QUESTIONS.md R8).
    for (const other of this.joinedSockets()) {
      const o = attachmentOf(other)
      if (o && o.connectionId !== att.connectionId && o.lock && footprintTouchesCell(footprint, o.lock)) return reject('locked')
    }

    const applied = live.engine.apply(msg.mutations)
    if (applied.failedAt >= 0) {
      console.error(`[room] mutation ${msg.mutations[applied.failedAt]?.id} not applied`, applied.error instanceof Error ? applied.error.message : '')
      await this.rebuild(live)
      return reject('not_applied')
    }

    const entry: LogEntry = {
      seq: live.seq + 1,
      kind: 'op',
      clientId: att.clientId,
      userId: att.userId,
      opId: msg.opId,
      origin: 'user',
      mutations: msg.mutations,
      footprint,
      version: null,
    }
    this.record(live, entry)
    // OPEN: a room commit names the author of its last op (apps/api/OPEN_QUESTIONS.md R13).
    live.lastAuthor = att.userId
    this.send(ws, { type: 'ack', opId: msg.opId, seq: entry.seq })
    this.broadcast({ type: 'op', op: toRoomOp(entry) }, ws)
    await this.schedulePersist(live)
  }

  private lock(ws: WebSocket, att: Attachment, cell: RoomCell): void {
    if (!canWrite(att.access)) {
      return this.send(ws, { type: 'lock-denied', cell, heldBy: null, message: LOCK_FORBIDDEN_MESSAGE })
    }
    for (const other of this.joinedSockets()) {
      const o = attachmentOf(other)
      if (o && o.connectionId !== att.connectionId && o.lock && sameCell(o.lock, cell)) {
        return this.send(ws, { type: 'lock-denied', cell, heldBy: { connectionId: o.connectionId, userId: o.userId }, message: LOCK_DENIED_MESSAGE })
      }
    }
    att.lock = cell
    ws.serializeAttachment(att)
    this.broadcastLocks()
  }

  private async departed(ws: WebSocket): Promise<void> {
    const att = attachmentOf(ws)
    this.assemblers.delete(ws)
    if (!att?.joined) return
    // Presence and locks of a dropped connection go with it (spec §11).
    this.broadcastPresence(ws)
    this.broadcastLocks(ws)
    if (this.joinedSockets(ws).length > 0) return
    await this.exclusive(async () => {
      if (this.joinedSockets(ws).length > 0) return
      if (!this.live) return
      const result = await this.persist()
      if (result === 'busy') await this.ctx.storage.setAlarm(Date.now() + PERSIST_RETRY_MS)
      else if (result === 'gone') this.closeAll()
      else this.releaseIfIdle(ws)
    })
  }

  // ── State ────────────────────────────────────────────────────────────────

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch((error: unknown) => console.error('[room] step failed', error instanceof Error ? error.message : 'unknown'))
    return run
  }

  private async load(snapshot: Record<string, unknown>, workbookId: string): Promise<HeadlessWorkbook> {
    // Imported on first use: the API Worker shares this script, and Univer
    // adds ~70 ms of startup when evaluated eagerly (phase 6 spike).
    const { loadHeadlessWorkbook } = await import('./room/engine')
    const data = { ...snapshot }
    if (typeof data.id !== 'string' || data.id === '') data.id = workbookId
    return loadHeadlessWorkbook(data)
  }

  private async readCommitted(workbookId: string, version: number): Promise<Record<string, unknown>> {
    const read = await readSnapshotText(this.env, workbookId, version)
    if (!read) throw new RoomUnavailable(`snapshot ${version} missing`)
    if (read.chars > MAX_LIVE_SNAPSHOT_CHARS) throw new RoomRefused(`snapshot ${version} has ${read.chars} characters`)
    return read.snapshot
  }

  /** The live state, loading it from the committed snapshot and the op log when needed. */
  private async ensureLive(workbookId: string): Promise<Live> {
    if (this.live) return this.live
    const d1 = await currentVersion(this.env, workbookId)
    if (d1 === null) throw new RoomUnavailable('workbook not found or archived')
    const meta = this.store.meta()
    const known = meta !== null && meta.workbookId === workbookId ? meta : null

    let live: Live
    if (!known || (d1 !== known.version && known.seq === known.persistedSeq)) {
      // First session, or a newer version was committed outside the room
      // while it held nothing unsaved: adopt it.
      const engine = await this.load(await this.readCommitted(workbookId, d1), workbookId)
      const seq = known?.seq ?? 0
      live = { workbookId, engine, seq, version: d1, persistedSeq: seq, recent: [], lastAuthor: 'system', dirtySince: null }
      if (known) {
        // Clients that knew the old state must reload.
        this.record(live, { seq: seq + 1, kind: 'reset', clientId: null, userId: 'system', opId: null, origin: 'server', mutations: [], footprint: STRUCTURAL, version: d1 })
        live.persistedSeq = live.seq
      }
    } else {
      // The room's own committed version, plus the ops it applied since.
      if (d1 !== known.version) this.store.event('superseded_on_load', { committed: d1, room: known.version, unsavedOps: known.seq - known.persistedSeq })
      const engine = await this.load(await this.readCommitted(workbookId, known.version), workbookId)
      live = { workbookId, engine, seq: known.seq, version: known.version, persistedSeq: known.persistedSeq, recent: [], lastAuthor: 'system', dirtySince: null }
      this.replay(live)
      if (live.seq !== live.persistedSeq) live.dirtySince = Date.now()
    }
    live.recent = this.store.tail(live.seq, CONFLICT_WINDOW).map((e) => ({ seq: e.seq, clientId: e.clientId, opId: e.opId, footprint: e.footprint }))
    const last = live.recent.length > 0 ? this.store.range(live.seq - 1, live.seq)[0] : undefined
    if (last) live.lastAuthor = last.userId
    this.writeMeta(live)
    await live.engine.settle(5_000)
    this.live = live
    if (live.dirtySince !== null) await this.schedulePersist(live)
    return live
  }

  /** Re-applies the logged ops after the committed version. */
  private replay(live: Live): void {
    for (const entry of this.store.range(live.persistedSeq, live.seq)) {
      if (entry.kind !== 'op') continue
      const applied = live.engine.apply(entry.mutations)
      if (applied.failedAt >= 0) {
        // Kept in the log for investigation; clients resync on the reset.
        this.store.event('replay_failed', { seq: entry.seq, mutation: entry.mutations[applied.failedAt]?.id ?? null })
        this.record(live, { seq: live.seq + 1, kind: 'reset', clientId: null, userId: 'system', opId: null, origin: 'server', mutations: [], footprint: STRUCTURAL, version: live.version })
        return
      }
    }
  }

  /** Rebuilds the headless instance from durable state (after a mutation failed halfway). */
  private async rebuild(live: Live): Promise<void> {
    live.engine.dispose()
    live.engine = await this.load(await this.readCommitted(live.workbookId, live.version), live.workbookId)
    this.replay(live)
    this.writeMeta(live)
  }

  private record(live: Live, entry: LogEntry): void {
    this.store.append(entry)
    live.seq = entry.seq
    live.recent.push({ seq: entry.seq, clientId: entry.clientId, opId: entry.opId, footprint: entry.footprint })
    if (live.recent.length > CONFLICT_WINDOW) live.recent.splice(0, live.recent.length - CONFLICT_WINDOW)
    this.writeMeta(live)
  }

  private writeMeta(live: Live): void {
    this.store.setMeta({ workbookId: live.workbookId, seq: live.seq, version: live.version, persistedSeq: live.persistedSeq })
  }

  private async schedulePersist(live: Live): Promise<void> {
    const now = Date.now()
    live.dirtySince ??= now
    await this.ctx.storage.setAlarm(Math.min(now + PERSIST_DEBOUNCE_MS, live.dirtySince + PERSIST_MAX_WAIT_MS))
  }

  /** Drops the headless instance when nobody is connected and everything is committed. */
  private releaseIfIdle(except?: WebSocket): void {
    const live = this.live
    if (!live || this.joinedSockets(except).length > 0 || live.seq !== live.persistedSeq) return
    live.engine.dispose()
    this.live = null
  }

  /** The workbook is gone: tell everyone, close, and drop the headless instance (the log keeps the ops). */
  private closeAll(): void {
    for (const ws of this.joinedSockets()) this.fail(ws, 'unavailable')
    this.live?.engine.dispose()
    this.live = null
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  /**
   * Commits the live state when it holds unsaved ops. 'busy': another writer
   * took the version, try again later; 'gone': the workbook was deleted or
   * archived, nothing more can be committed (the ops stay in the log).
   */
  private async persist(): Promise<'done' | 'busy' | 'gone'> {
    const live = this.live
    if (!live || live.seq === live.persistedSeq) return 'done'
    await live.engine.settle(1_000)
    const seqAt = live.seq
    const body = JSON.stringify(live.engine.snapshot())
    const commit = await commitOnTop(this.env, live.workbookId, body, live.lastAuthor, DEFAULT_SNAPSHOT_ORPHAN_AGE_MS)
    if (commit.status === 'gone') {
      this.store.event('commit_gone', { seq: seqAt })
      return 'gone'
    }
    if (commit.status === 'busy') return 'busy'
    const fromSeq = this.committed(live, commit.base, commit.version, seqAt)
    await this.afterCommit(live, commit.base, commit.version, fromSeq, seqAt)
    return 'done'
  }

  /**
   * Records a commit; returns the persisted seq before it (the edits it adds
   * start after that). `roomVersion`: the version the room's state was built on.
   */
  private committed(live: Live, base: number, version: number, seqAt: number, roomVersion: number = live.version): number {
    // A save that did not come through the room (a browser PUT while the
    // session was live) is superseded, never overwritten: it stays in R2.
    // OPEN: PUT /snapshot could refuse while a session is live (apps/api/OPEN_QUESTIONS.md R7).
    if (base !== roomVersion) this.store.event('superseded', { version: base, roomVersion, committed: version })
    const fromSeq = live.persistedSeq
    live.version = version
    live.persistedSeq = seqAt
    live.dirtySince = null
    this.writeMeta(live)
    this.broadcast({ type: 'saved', version, seq: seqAt })
    return fromSeq
  }

  private async afterCommit(live: Live, previousVersion: number, version: number, fromSeq: number, toSeq: number): Promise<void> {
    const edits = this.store
      .range(fromSeq, toSeq)
      .filter((e) => e.kind === 'op')
      .map((e) => ({ seq: e.seq, origin: e.origin, userId: e.userId, footprint: e.footprint }))
    try {
      // WAVE3-SEAM: outbound detection — installed by sync/outbound through
      // room/outbound-seam.ts `setOutboundDetection`; a no-op until then.
      await outboundDetection()(this.env, { workbookId: live.workbookId, version, previousVersion, edits })
    } catch (error) {
      console.error('[room] outbound detection failed', error instanceof Error ? error.message : 'unknown')
    }
  }

  // ── Server changes ───────────────────────────────────────────────────────

  private async directServerChange(request: ServerChangeRequest, change: RemoteChange): Promise<ServerChangeOutcome> {
    try {
      const outcome = await directUpdate(
        this.env,
        request.workbookId,
        request.savedBy,
        async (snapshot, version) => {
          const r = await change(snapshot, version)
          if (!r.ok) throw new ChangeFailed()
          return { snapshot: r.snapshot, result: null }
        },
        { attempts: request.attempts, orphanAgeMs: request.orphanAgeMs },
      )
      if (outcome.status === 'written' || outcome.status === 'unchanged') return { status: outcome.status, version: outcome.version }
      return { status: outcome.status }
    } catch (error) {
      if (error instanceof ChangeFailed) return { status: 'change_failed' }
      throw error
    }
  }

  private async liveServerChange(request: ServerChangeRequest, change: RemoteChange): Promise<ServerChangeOutcome> {
    let live: Live
    try {
      live = await this.ensureLive(request.workbookId)
    } catch (error) {
      if (error instanceof RoomUnavailable) return { status: 'not_found' }
      throw error
    }
    for (let attempt = 0; attempt < request.attempts; attempt++) {
      await live.engine.settle(2_000)
      const before = live.engine.snapshot()
      const r = await change(before, live.version)
      if (!r.ok) return { status: 'change_failed' }
      if (r.snapshot === null) return { status: 'unchanged', version: live.version }
      if (!isObject(r.snapshot)) throw new Error('server change returned a snapshot that is not an object')
      const after = r.snapshot

      const commit = await commitOnTop(this.env, request.workbookId, JSON.stringify(after), request.savedBy, request.orphanAgeMs)
      if (commit.status === 'gone') return { status: 'not_found' }
      if (commit.status === 'busy') continue

      // Moved first, so the resyncs of a reload carry the new version.
      const roomVersion = live.version
      live.version = commit.version
      await this.applyServerSnapshot(live, before, after, request.savedBy, commit.version)
      const fromSeq = this.committed(live, commit.base, commit.version, live.seq, roomVersion)
      await this.afterCommit(live, commit.base, commit.version, fromSeq, live.seq)
      return { status: 'written', version: commit.version }
    }
    return { status: 'contended' }
  }

  /** Brings the live state to the committed `after` and tells every editor. */
  private async applyServerSnapshot(live: Live, before: Record<string, unknown>, after: Record<string, unknown>, savedBy: string, version: number): Promise<void> {
    const plan = planServerChange(before, after)
    if (plan.kind === 'none') return
    if (plan.kind === 'cells') {
      const mutations = cellMutations(live.engine.unitId, plan.cells)
      const applied = live.engine.apply(mutations)
      if (applied.failedAt < 0 && cellsMatch(live.engine.snapshot(), plan.cells)) {
        const entry: LogEntry = {
          seq: live.seq + 1,
          kind: 'op',
          clientId: null,
          userId: savedBy,
          opId: null,
          origin: 'server',
          mutations,
          footprint: { structural: false, cells: cellSpans(plan.cells), rows: [], columns: [], keys: [] },
          version: null,
        }
        this.record(live, entry)
        this.broadcast({ type: 'op', op: toRoomOp(entry) })
        return
      }
      this.store.event('server_change_fallback', { cells: plan.cells.length })
    }
    // Anything else: reload from the committed snapshot; every editor resyncs.
    // OPEN: no finer broadcast of structural server changes yet (apps/api/OPEN_QUESTIONS.md R11).
    live.engine.dispose()
    live.engine = await this.load(after, live.workbookId)
    await live.engine.settle(5_000)
    this.record(live, { seq: live.seq + 1, kind: 'reset', clientId: null, userId: savedBy, opId: null, origin: 'server', mutations: [], footprint: STRUCTURAL, version })
    for (const ws of this.joinedSockets()) this.resync(ws, live, 'server_change')
  }

  // ── Messages ─────────────────────────────────────────────────────────────

  private resync(ws: WebSocket, live: Live, reason: RoomResync['reason']): void {
    const att = attachmentOf(ws)
    if (!att) return
    att.epoch += 1
    ws.serializeAttachment(att)
    this.send(ws, { type: 'resync', epoch: att.epoch, seq: live.seq, version: live.version, snapshot: live.engine.snapshot(), reason })
  }

  private joinedSockets(except?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => ws !== except && ws.readyState === 1 && attachmentOf(ws)?.joined === true)
  }

  private peers(except?: WebSocket): RoomPeer[] {
    return this.joinedSockets(except).flatMap((ws) => {
      const a = attachmentOf(ws)
      return a ? [{ connectionId: a.connectionId, userId: a.userId, name: a.name, readOnly: !canWrite(a.access), cell: a.cell }] : []
    })
  }

  private locks(except?: WebSocket): RoomLock[] {
    return this.joinedSockets(except).flatMap((ws) => {
      const a = attachmentOf(ws)
      return a?.lock ? [{ connectionId: a.connectionId, userId: a.userId, cell: a.lock }] : []
    })
  }

  /** `departed`: a connection leaving, kept out of the list and not sent to. */
  private broadcastPresence(departed?: WebSocket): void {
    this.broadcast({ type: 'presence', peers: this.peers(departed) }, departed)
  }

  /** `departed`: as for presence. */
  private broadcastLocks(departed?: WebSocket): void {
    this.broadcast({ type: 'locks', locks: this.locks(departed) }, departed)
  }

  private broadcast(msg: RoomServerMessage, except?: WebSocket): void {
    const frames = toFrames(JSON.stringify(msg), crypto.randomUUID())
    for (const ws of this.joinedSockets(except)) for (const f of frames) safeSend(ws, f)
  }

  private send(ws: WebSocket, msg: RoomServerMessage): void {
    for (const f of toFrames(JSON.stringify(msg), crypto.randomUUID())) safeSend(ws, f)
  }

  private fail(ws: WebSocket, code: RoomErrorCode): void {
    this.send(ws, { type: 'error', code, message: ERROR_MESSAGES[code] })
    const close = CLOSE_FOR[code]
    if (close !== null) {
      try {
        ws.close(close, code)
      } catch {
        // Already closed.
      }
    }
  }
}

function attachmentOf(ws: WebSocket): Attachment | null {
  try {
    return (ws.deserializeAttachment() as Attachment | null) ?? null
  } catch {
    return null
  }
}

function safeSend(ws: WebSocket, frame: string): void {
  try {
    ws.send(frame)
  } catch {
    // The socket closed meanwhile; its close handler cleans up.
  }
}

function sameCell(a: RoomCell, b: RoomCell): boolean {
  return a.sheetId === b.sheetId && a.row === b.row && a.column === b.column
}

function toRoomOp(entry: LogEntry): RoomOp {
  return {
    seq: entry.seq,
    origin: entry.origin === 'server' || entry.clientId === null ? { kind: 'server', savedBy: entry.userId } : { kind: 'user', userId: entry.userId, clientId: entry.clientId },
    opId: entry.opId,
    mutations: entry.mutations,
  }
}
