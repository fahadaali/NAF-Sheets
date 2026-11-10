// What the room tells outbound sync after it commits a snapshot (spec §9.2.1:
// "the Durable Object determines the affected task_uid"). The outbound work
// (apps/api/src/sync/outbound/) supplies the detection; until it does, the
// default does nothing. This module imports nothing from sync/outbound.

import type { Env } from '../env'
import type { Footprint } from './footprint'

export interface RoomEdit {
  seq: number
  /** 'server': a change made through updateLatestSnapshot (already known to the sync code). */
  origin: 'user' | 'server'
  /** members.user_id of the editor (the token outbound must use, spec §3), or the server change's savedBy. */
  userId: string
  /** What the op touched (cells, rows, columns, sheet/plugin keys; `structural` for row/column/sheet changes). */
  footprint: Footprint
  /** Synced rows `userId` confirmed for deletion on this op (spec §9.2.7); absent when none. */
  confirmedDeletions?: string[]
}

export interface RoomCommitted {
  workbookId: string
  /** The version just committed. */
  version: number
  /** The version D1 held before this commit. */
  previousVersion: number
  /** Edits included for the first time in `version`, in room order. */
  edits: RoomEdit[]
  /** The snapshot just committed as `version` (what detection reads; not to be changed). */
  snapshot: Record<string, unknown>
}

export type OutboundDetection = (env: Env, event: RoomCommitted) => Promise<void>

const noOutboundDetection: OutboundDetection = async () => {}

let detection: OutboundDetection = noOutboundDetection

/** Installs the outbound detection (call once, at module load of the Worker entry). */
export function setOutboundDetection(fn: OutboundDetection | null): void {
  detection = fn ?? noOutboundDetection
}

export function outboundDetection(): OutboundDetection {
  return detection
}
