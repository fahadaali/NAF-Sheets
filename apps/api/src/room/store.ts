// The room's own durable storage (Durable Object SQLite, wrangler.toml
// `new_sqlite_classes`): the op log and the room's position. Together with the
// committed snapshot in R2 they are the room's state; the headless Univer is
// rebuilt from them after hibernation, eviction or a restart.
//
// Rows are never deleted.
// OPEN: retention of the op log (apps/api/OPEN_QUESTIONS.md R6).

import type { RoomMutation } from '@naf-sheets/shared'
import type { Footprint } from './footprint'

export interface RoomMeta {
  workbookId: string
  /** Last seq assigned. */
  seq: number
  /** The committed version the room's state builds on. */
  version: number
  /** Every entry up to this seq is included in `version`. */
  persistedSeq: number
}

export interface LogEntry {
  seq: number
  /** 'op': mutations applied in order; 'reset': the state was replaced by committed version `version`. */
  kind: 'op' | 'reset'
  clientId: string | null
  userId: string
  opId: string | null
  origin: 'user' | 'server'
  mutations: RoomMutation[]
  footprint: Footprint
  /** For 'reset': the committed version loaded. */
  version: number | null
  /** Synced rows the op's author confirmed for deletion (spec §9.2.7), or null. */
  confirmedDeletions: string[] | null
}

interface OpRow extends Record<string, SqlStorageValue> {
  seq: number
  kind: string
  client_id: string | null
  user_id: string
  op_id: string | null
  origin: string
  mutations: string
  footprint: string
  version: number | null
  confirmed: string | null
}

function toEntry(row: OpRow): LogEntry {
  return {
    seq: row.seq,
    kind: row.kind === 'reset' ? 'reset' : 'op',
    clientId: row.client_id,
    userId: row.user_id,
    opId: row.op_id,
    origin: row.origin === 'server' ? 'server' : 'user',
    mutations: JSON.parse(row.mutations) as RoomMutation[],
    footprint: JSON.parse(row.footprint) as Footprint,
    version: row.version,
    confirmedDeletions: row.confirmed ? (JSON.parse(row.confirmed) as string[]) : null,
  }
}

export class RoomStore {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS room_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    sql.exec(
      `CREATE TABLE IF NOT EXISTS room_ops (
         seq INTEGER PRIMARY KEY,
         kind TEXT NOT NULL,
         client_id TEXT,
         user_id TEXT NOT NULL,
         op_id TEXT,
         origin TEXT NOT NULL,
         mutations TEXT NOT NULL,
         footprint TEXT NOT NULL,
         version INTEGER,
         applied_at INTEGER NOT NULL,
         confirmed TEXT
       )`,
    )
    // Rooms created before confirmed deletions were logged (no row is rewritten).
    const columns = sql.exec<{ name: string }>(`PRAGMA table_info(room_ops)`).toArray().map((c) => c.name)
    if (!columns.includes('confirmed')) sql.exec(`ALTER TABLE room_ops ADD COLUMN confirmed TEXT`)
    sql.exec(`CREATE TABLE IF NOT EXISTS room_events (at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL)`)
  }

  meta(): RoomMeta | null {
    const row = this.sql.exec<{ value: string }>(`SELECT value FROM room_meta WHERE key = 'state'`).toArray()[0]
    return row ? (JSON.parse(row.value) as RoomMeta) : null
  }

  setMeta(meta: RoomMeta): void {
    this.sql.exec(`INSERT INTO room_meta (key, value) VALUES ('state', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, JSON.stringify(meta))
  }

  append(entry: LogEntry): void {
    this.sql.exec(
      `INSERT INTO room_ops (seq, kind, client_id, user_id, op_id, origin, mutations, footprint, version, applied_at, confirmed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.seq,
      entry.kind,
      entry.clientId,
      entry.userId,
      entry.opId,
      entry.origin,
      JSON.stringify(entry.mutations),
      JSON.stringify(entry.footprint),
      entry.version,
      Date.now(),
      entry.confirmedDeletions && entry.confirmedDeletions.length > 0 ? JSON.stringify(entry.confirmedDeletions) : null,
    )
  }

  /** Entries with `from < seq <= to`, in order. */
  range(from: number, to: number): LogEntry[] {
    return this.sql.exec<OpRow>(`SELECT * FROM room_ops WHERE seq > ? AND seq <= ? ORDER BY seq`, from, to).toArray().map(toEntry)
  }

  /** The last `count` entries up to `to`, in order. */
  tail(to: number, count: number): LogEntry[] {
    return this.sql
      .exec<OpRow>(`SELECT * FROM room_ops WHERE seq <= ? ORDER BY seq DESC LIMIT ?`, to, count)
      .toArray()
      .map(toEntry)
      .reverse()
  }

  /** Something unusual the room did (a superseded browser save, a replay failure), kept for investigation. */
  event(kind: string, detail: Record<string, unknown>): void {
    this.sql.exec(`INSERT INTO room_events (at, kind, detail) VALUES (?, ?, ?)`, Date.now(), kind, JSON.stringify(detail))
  }

  events(): Array<{ kind: string; detail: Record<string, unknown> }> {
    return this.sql
      .exec<{ kind: string; detail: string }>(`SELECT kind, detail FROM room_events ORDER BY at, rowid`)
      .toArray()
      .map((r) => ({ kind: r.kind, detail: JSON.parse(r.detail) as Record<string, unknown> }))
  }
}
