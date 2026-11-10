// WebSocket protocol of the workbook room (spec §11, §5.3 default (a)).
// One definition for apps/api (the Durable Object `WorkbookRoom`) and
// apps/web (`lib/room-client.ts`). Exported from ./index.
//
// Model: the server is the source of truth. Editors apply their own Univer
// mutations at once and send them as an *op* carrying the room sequence
// number they had seen (`baseSeq`). The room applies ops in arrival order to
// its own headless Univer, gives each a new `seq`, acknowledges it to the
// sender and broadcasts it to everyone else. An op is refused when a newer op
// from someone else touched the same cells, or when either side is a
// structural change (rows, columns, sheets); the sender then reloads the
// room's state (`resync`). Ops that touch different cells commute, so every
// editor converges on the room's state.
//
// Connect: GET /api/workbooks/:id/room (WebSocket, cookie auth). Every frame
// is one JSON text message. The client speaks first, with `hello`.

/** Bumped on any incompatible change; the room closes a connection that speaks another version. */
export const ROOM_PROTOCOL_VERSION = 1

/** Close codes the room uses (4000–4999 are application codes). */
export const ROOM_CLOSE = {
  /** The client spoke another protocol version: reload the page. */
  protocolMismatch: 4400,
  /** The workbook no longer exists, was archived, or its snapshot is missing. */
  unavailable: 4404,
  /** Malformed frames: the client is broken. */
  badMessage: 4405,
  /** The room refused to open the workbook live (e.g. too large). */
  refused: 4413,
} as const

/**
 * A message longer than this many characters is sent as `chunk` frames (both
 * directions). Counted in UTF-16 units: at most 3 UTF-8 bytes each, so a
 * frame stays under 768 KiB on the wire, below a 1 MiB message limit.
 */
// OPEN: the Workers WebSocket message limit in production (apps/api/OPEN_QUESTIONS.md R4).
export const ROOM_CHUNK_CHARS = 256 * 1024

// ── Shared values ───────────────────────────────────────────────────────────

/** One cell; `sheetId` is the Univer sheet id (the key in `IWorkbookData.sheets`). Row and column are 0-based. */
export interface RoomCell {
  sheetId: string
  row: number
  column: number
}

/** One Univer mutation as `ICommandService` runs it: its id and JSON parameters. */
export interface RoomMutation {
  id: string
  params: Record<string, unknown>
}

/** Who made an op: a connected editor, or the server (inbound sync, link wizard, restore). */
export type RoomOrigin =
  | { kind: 'user'; userId: string; clientId: string }
  | { kind: 'server'; savedBy: string }

/** An applied op, in room order. The mutations of one op are applied together. */
export interface RoomOp {
  seq: number
  origin: RoomOrigin
  /** The sender's id for the op (client ops only), so a reconnecting client recognises its own. */
  opId: string | null
  mutations: RoomMutation[]
}

export type RoomAccess = 'admin' | 'owner' | 'editor' | 'viewer'

/** A connected editor (one per connection: a person with two tabs appears twice). */
export interface RoomPeer {
  connectionId: string
  userId: string
  /** members.display_name, or null when unknown. */
  name: string | null
  readOnly: boolean
  /** The cell this person has selected, or null. */
  cell: RoomCell | null
}

/** A soft lock (spec §11): the cell `connectionId` is editing appears locked to everyone else. */
export interface RoomLock {
  connectionId: string
  userId: string
  cell: RoomCell
}

// ── Client → room ───────────────────────────────────────────────────────────

/**
 * First frame. `seq` is the last room seq this client applied (null on first
 * join): the room answers with the ops after it (catch-up) when it still can,
 * or with a full snapshot.
 */
export interface RoomHello {
  type: 'hello'
  protocol: number
  /** Stable for one editor session (survives reconnects); a random id. */
  clientId: string
  seq: number | null
  /**
   * First join only: the committed version the editor already shows (from
   * GET /api/workbooks/:id). When the room holds exactly that version and
   * nothing more, it answers with an empty catch-up instead of the snapshot,
   * so the editor does not reload what it already has.
   */
  version?: number | null
}

export interface RoomOpMessage {
  type: 'op'
  /** Unique per client; a resent op with the same id is applied once. */
  opId: string
  /** The room seq this client had applied when it made the op. */
  baseSeq: number
  /** The epoch of the client's current state (see `RoomResync`). */
  epoch: number
  mutations: RoomMutation[]
  /**
   * Synced task rows this person removed AND confirmed in the deletion dialog
   * (spec §9.2.7), sent on the op that removes them. The room logs them with
   * the op and its author; after the commit, only these rows may be deleted
   * in Basecamp, with this person's token. A synced row missing from the
   * workbook and not confirmed never touches Basecamp.
   */
  confirmedDeletions?: string[]
}

/** The cell this client has selected (null: none / another sheet). */
export interface RoomPresenceMessage {
  type: 'presence'
  cell: RoomCell | null
}

/** Ask for the soft lock on the cell about to be edited; answered by `locks` or `lock-denied`. */
export interface RoomLockMessage {
  type: 'lock'
  cell: RoomCell
}

/** Release this connection's lock (editing finished or cancelled). */
export interface RoomUnlockMessage {
  type: 'unlock'
}

/** Ask for the room's state again (answered with `resync`). */
export interface RoomResyncRequest {
  type: 'resync'
}

export interface RoomPing {
  type: 'ping'
}

export type RoomClientMessage =
  | RoomHello
  | RoomOpMessage
  | RoomPresenceMessage
  | RoomLockMessage
  | RoomUnlockMessage
  | RoomResyncRequest
  | RoomPing
  | RoomChunk

// ── Room → client ───────────────────────────────────────────────────────────

interface RoomStateBase {
  /** Ops the client sends from now on carry this epoch. */
  epoch: number
  /** The room seq the state below includes. */
  seq: number
  /** The committed snapshot version the room last persisted (D1 `current_snapshot_version`). */
  version: number
}

/** Answer to `hello`. Either the whole state (`snapshot`) or the ops after the client's `seq` (`ops`). */
export type RoomWelcome = RoomStateBase & {
  type: 'welcome'
  protocol: number
  connectionId: string
  userId: string
  /** Viewers: the room refuses every op and lock from this connection. */
  readOnly: boolean
  peers: RoomPeer[]
  locks: RoomLock[]
} & ({ mode: 'snapshot'; snapshot: Record<string, unknown> } | { mode: 'catchup'; ops: RoomOp[] })

/** Your op was applied as `seq`. */
export interface RoomAck {
  type: 'ack'
  opId: string
  seq: number
}

export type RoomRejectReason =
  /** A newer op from someone else touched the same cells, or a structural change was involved. */
  | 'conflict'
  /** The op touches a cell another person is editing (soft lock). */
  | 'locked'
  /** Read-only connection (workbook viewer). */
  | 'forbidden'
  /** Malformed, a mutation the room does not accept, or another workbook's unit. */
  | 'invalid'
  /** Univer refused to apply it in the room. */
  | 'not_applied'
  /** Made before the client's last resync; dropped. No resync follows. */
  | 'stale_epoch'

/**
 * Your op was not applied. Unless the reason is `stale_epoch`, a `resync`
 * follows: drop every op not yet acknowledged and load the state it carries.
 */
export interface RoomReject {
  type: 'reject'
  opId: string
  reason: RoomRejectReason
  /** Arabic, for the user: what happened and what to do. */
  message: string
}

/** Someone else's op (or a server change), applied as `op.seq`. */
export interface RoomBroadcast {
  type: 'op'
  op: RoomOp
}

/** Replace your state with this one; ops not yet acknowledged are dropped. */
export type RoomResync = RoomStateBase & {
  type: 'resync'
  snapshot: Record<string, unknown>
  reason: 'rejected' | 'requested' | 'server_change'
}

export interface RoomPresence {
  type: 'presence'
  peers: RoomPeer[]
}

export interface RoomLocks {
  type: 'locks'
  locks: RoomLock[]
}

export interface RoomLockDenied {
  type: 'lock-denied'
  cell: RoomCell
  /** Who holds the lock; null when this connection may not edit at all (viewer). */
  heldBy: { connectionId: string; userId: string } | null
  /** Arabic. */
  message: string
}

/** The room committed its state as snapshot `version`, including every op up to `seq`. */
export interface RoomSaved {
  type: 'saved'
  version: number
  seq: number
}

export type RoomErrorCode = 'protocol_mismatch' | 'unavailable' | 'bad_message' | 'refused' | 'not_joined'

export interface RoomError {
  type: 'error'
  code: RoomErrorCode
  /** Arabic, for the user. */
  message: string
}

export interface RoomPong {
  type: 'pong'
}

export type RoomServerMessage =
  | RoomWelcome
  | RoomAck
  | RoomReject
  | RoomBroadcast
  | RoomResync
  | RoomPresence
  | RoomLocks
  | RoomLockDenied
  | RoomSaved
  | RoomError
  | RoomPong
  | RoomChunk

// ── Framing ─────────────────────────────────────────────────────────────────

/**
 * Part `index` (0-based) of `count` of one message too large for a frame:
 * the receiver concatenates `data` in order and parses the result as one
 * message. Parts of one message are sent consecutively.
 */
export interface RoomChunk {
  type: 'chunk'
  id: string
  index: number
  count: number
  data: string
}

/** Splits `json` into frames of at most ROOM_CHUNK_CHARS characters of data (one frame when it fits). */
export function toFrames(json: string, id: string, limit: number = ROOM_CHUNK_CHARS): string[] {
  if (json.length <= limit) return [json]
  const count = Math.ceil(json.length / limit)
  const frames: string[] = []
  for (let index = 0; index < count; index++) {
    const chunk: RoomChunk = { type: 'chunk', id, index, count, data: json.slice(index * limit, (index + 1) * limit) }
    frames.push(JSON.stringify(chunk))
  }
  return frames
}

/** Reassembles `chunk` frames. `push` returns the complete message text, or null while parts are missing. */
export class FrameAssembler {
  private id: string | null = null
  private parts: string[] = []
  private size = 0

  constructor(private readonly maxChars: number) {}

  /** Throws on an out-of-order part or a message over `maxChars`. */
  push(chunk: RoomChunk): string | null {
    if (chunk.index === 0) {
      this.id = chunk.id
      this.parts = []
      this.size = 0
    }
    if (chunk.id !== this.id || chunk.index !== this.parts.length || chunk.count < 1 || chunk.index >= chunk.count) {
      this.reset()
      throw new Error('room frame out of order')
    }
    this.size += chunk.data.length
    if (this.size > this.maxChars) {
      this.reset()
      throw new Error('room message too large')
    }
    this.parts.push(chunk.data)
    if (this.parts.length < chunk.count) return null
    const text = this.parts.join('')
    this.reset()
    return text
  }

  reset(): void {
    this.id = null
    this.parts = []
    this.size = 0
  }
}

// ── Mutations the room accepts ──────────────────────────────────────────────

/**
 * How a mutation interacts with concurrent ops:
 * - `cells`: touches the cells it names (values, formulas, styles, formats, merges);
 * - `rows` / `columns`: row or column properties (height, width, hidden);
 * - `sheet`: one sheet's own properties (name, colour, frozen panes, gridlines);
 * - `workbook`: workbook-wide properties (name, sheet order, defined names);
 * - `resource`: a plugin's data on one sheet (validation, conditional formats, filter, links, notes);
 * - `structural`: shifts or removes cells (rows, columns, sheets, moves, sorts) — refused when anything else is concurrent.
 */
export type RoomMutationClass = 'cells' | 'rows' | 'columns' | 'sheet' | 'workbook' | 'resource' | 'structural'

/**
 * Every mutation the room accepts, from @univerjs/* 1.4.0 (the ids the
 * editors' collaboration hook emits, checked in apps/api/test/room). Any
 * other id is refused (`invalid`) and the sender resyncs. Formula-engine
 * mutations are absent on purpose: Univer runs them locally only, and every
 * editor and the room compute formulas themselves.
 */
// OPEN: protection, range themes, calculation settings and the copy-sheet
// lazy path are not accepted yet (apps/api/OPEN_QUESTIONS.md R2).
export const ROOM_MUTATIONS: Readonly<Record<string, RoomMutationClass>> = {
  // Cells
  'sheet.mutation.set-range-values': 'cells',
  'sheet.mutation.set.numfmt': 'cells',
  'sheet.mutation.remove.numfmt': 'cells',
  'sheet.mutation.add-worksheet-merge': 'cells',
  'sheet.mutation.remove-worksheet-merge': 'cells',
  // Rows and columns
  'sheet.mutation.set-worksheet-row-height': 'rows',
  'sheet.mutation.set-worksheet-row-is-auto-height': 'rows',
  'sheet.mutation.set-worksheet-row-auto-height': 'rows',
  'sheet.mutation.set-row-hidden': 'rows',
  'sheet.mutation.set-row-visible': 'rows',
  'sheet.mutation.set-row-data': 'rows',
  'sheet.mutation.set-worksheet-col-width': 'columns',
  'sheet.mutation.set-col-hidden': 'columns',
  'sheet.mutation.set-col-visible': 'columns',
  'sheet.mutation.set-col-data': 'columns',
  // One sheet
  'sheet.mutation.set-worksheet-name': 'sheet',
  'sheet.mutation.set-tab-color': 'sheet',
  'sheet.mutation.set-worksheet-hidden': 'sheet',
  'sheet.mutation.set-frozen': 'sheet',
  'sheet.mutation.toggle-gridlines': 'sheet',
  'sheet.mutation.set-gridlines-color': 'sheet',
  'sheet.mutation.set-worksheet-default-style': 'sheet',
  // Workbook
  'sheet.mutation.set-workbook-name': 'workbook',
  'sheet.mutation.set-worksheet-order': 'workbook',
  'formula.mutation.set-defined-name': 'workbook',
  'formula.mutation.remove-defined-name': 'workbook',
  // Plugin rules
  'data-validation.mutation.addRule': 'resource',
  'data-validation.mutation.removeRule': 'resource',
  'data-validation.mutation.updateRule': 'resource',
  'sheet.mutation.add-conditional-rule': 'resource',
  'sheet.mutation.delete-conditional-rule': 'resource',
  'sheet.mutation.set-conditional-rule': 'resource',
  'sheet.mutation.move-conditional-rule': 'resource',
  'sheet.mutation.set-filter-range': 'resource',
  'sheet.mutation.set-filter-criteria': 'resource',
  'sheet.mutation.remove-filter': 'resource',
  'sheet.mutation.re-calc-filter': 'resource',
  'sheets.mutation.add-hyper-link': 'resource',
  'sheets.mutation.update-hyper-link': 'resource',
  'sheets.mutation.remove-hyper-link': 'resource',
  'sheets.mutation.update-hyper-link-ref': 'resource',
  'sheets.mutation.update-rich-hyper-link': 'resource',
  // Notes may be addressed by note id alone, so they count per sheet.
  'sheet.mutation.update-note': 'resource',
  'sheet.mutation.remove-note': 'resource',
  'sheet.mutation.update-note-position': 'resource',
  'sheet.mutation.toggle-note-popup': 'resource',
  // Structural
  'sheet.mutation.insert-row': 'structural',
  'sheet.mutation.remove-rows': 'structural',
  'sheet.mutation.insert-col': 'structural',
  'sheet.mutation.remove-col': 'structural',
  'sheet.mutation.move-rows': 'structural',
  'sheet.mutation.move-columns': 'structural',
  'sheet.mutation.move-range': 'structural',
  'sheet.mutation.reorder-range': 'structural',
  'sheet.mutation.insert-sheet': 'structural',
  'sheet.mutation.remove-sheet': 'structural',
  'sheet.mutation.set-worksheet-row-count': 'structural',
  'sheet.mutation.set-worksheet-column-count': 'structural',
}

export function roomMutationClass(id: string): RoomMutationClass | null {
  return Object.prototype.hasOwnProperty.call(ROOM_MUTATIONS, id) ? ROOM_MUTATIONS[id]! : null
}

/** True when an op holding these mutation ids shifts or removes cells. */
export function isStructuralOp(mutations: readonly { id: string }[]): boolean {
  return mutations.some((m) => ROOM_MUTATIONS[m.id] === 'structural')
}

/** Room limits a client must respect. */
export const ROOM_LIMITS = {
  /** Confirmed deletions on one op, and characters of each uid. */
  maxConfirmedDeletions: 10_000,
  maxUidChars: 128,
  /** Mutations in one op. */
  maxMutationsPerOp: 500,
  /** Characters of one client message, after reassembly. */
  maxMessageChars: 8 * 1024 * 1024,
} as const
