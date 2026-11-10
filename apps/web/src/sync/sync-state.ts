// Per-row sync state (spec §5.2 «مؤشر المزامنة لكل صف», §9.2.8, §9.3.10)
// from GET /api/workbooks/:id/sync, and the poller that keeps it fresh while
// the editor is open (until the workbook room carries sync events, phase 6).

import type { AssignMode, TaskSyncInfo, TaskUid, WorkbookSyncResponse } from '@naf-sheets/shared'
import type { Clock } from '../lib/autosave'
import { systemClock } from '../lib/autosave'
import type { TaskRow } from './rows'

export type RowState = 'synced' | 'pending' | 'error' | 'conflict' | 'deleted'

export interface RowIndicator {
  row: number
  uid: TaskUid
  state: RowState
  /** Arabic, from the API (`error`, `conflict`). */
  message: string | null
  bcUrl: string | null
  assignMode: AssignMode | null
  remoteStatus: TaskSyncInfo['remoteStatus'] | null
}

/**
 * OPEN: rows the server does not list yet are pending; no sheet check (OPEN_QUESTIONS.md #45).
 * One indicator per task row. A row deleted in Basecamp shows that first; a
 * row the server does not know yet (just given a uid, not saved or not
 * processed) is pending. Nothing for an unlinked workbook.
 */
export function rowIndicators(info: WorkbookSyncResponse | null, rows: readonly TaskRow[]): Map<number, RowIndicator> {
  const out = new Map<number, RowIndicator>()
  if (!info || info.state === 'unlinked') return out
  const byUid = new Map(info.tasks.map((t) => [t.uid, t]))
  for (const r of rows) {
    const task = byUid.get(r.uid)
    if (!task) {
      out.set(r.row, { row: r.row, uid: r.uid, state: 'pending', message: null, bcUrl: null, assignMode: null, remoteStatus: null })
      continue
    }
    if (task.state === 'unlinked') continue
    const state: RowState = task.remoteStatus !== 'active' ? 'deleted' : task.state
    out.set(r.row, { row: r.row, uid: r.uid, state, message: task.message, bcUrl: task.bcUrl, assignMode: task.assignMode, remoteStatus: task.remoteStatus })
  }
  return out
}

export const POLL_INTERVAL_MS = 10_000

/**
 * Runs `run` now and then every `intervalMs` after the previous run ended
 * (never two at once). `poke()` runs it again right away (after a save);
 * a poke during a run queues exactly one more run.
 */
export class Poller {
  private timer: unknown = null
  private running = false
  private again = false
  private stopped = true
  private readonly clock: Clock

  constructor(
    private readonly run: () => Promise<void>,
    private readonly intervalMs = POLL_INTERVAL_MS,
    clock: Clock = systemClock,
  ) {
    this.clock = clock
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    void this.tick()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = null
  }

  poke(): void {
    if (this.stopped) return
    if (this.running) {
      this.again = true
      return
    }
    void this.tick()
  }

  private async tick(): Promise<void> {
    if (this.stopped) return
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = null
    this.running = true
    try {
      await this.run()
    } catch {
      // The caller reports failures; polling goes on.
    } finally {
      this.running = false
    }
    if (this.stopped) return
    if (this.again) {
      this.again = false
      void this.tick()
      return
    }
    this.timer = this.clock.setTimeout(() => void this.tick(), this.intervalMs)
  }
}
