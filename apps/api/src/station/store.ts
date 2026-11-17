// D1 access of the station (migrations/0010_station.sql).

import type { SyncedBase } from '@naf-sheets/shared'
import { alertKey, type StationAlert } from '@naf-sheets/station-sheet'

export interface LinkRow {
  id: string
  spreadsheet_id: string
  title: string
  bc_project_id: number
  bc_todoset_id: number
  roles_tab: string
  state: 'active' | 'paused'
  notify_secret: string
  last_modified: string | null
  last_sync_at: string | null
  /** When the last full pass (every to-do's subtasks read) finished; migrations/0012. */
  last_full_at: string | null
  /** Set when an admin unlinked it (the record is kept, migrations/0013); null while linked. */
  unlinked_at: string | null
  last_error: string | null
  created_by: string
  created_at: string
  updated_at: string
}

export interface TabRow {
  link_id: string
  google_sheet_id: number
  title: string
  bc_todolist_id: number | null
}

export interface TaskRow {
  uid: string
  link_id: string
  google_sheet_id: number
  level: 0 | 1
  parent_uid: string | null
  bc_id: number | null
  base_json: string | null
  subtasks_count: number | null
  subtasks_done: number | null
  deleted_remotely: 0 | 1
  /** «الحالة» before the record was deleted in Basecamp (migrations/0014). */
  status_before_delete: string | null
  assign_from_sheet: 0 | 1
  /** Project members last put on the to-do's completion list and subscribers (sorted ids). */
  notify_key: string | null
}

export async function getLink(db: D1Database, id: string): Promise<LinkRow | null> {
  return db.prepare(`SELECT * FROM station_links WHERE id = ?1`).bind(id).first<LinkRow>()
}

export async function getTabs(db: D1Database, linkId: string): Promise<TabRow[]> {
  const r = await db.prepare(`SELECT * FROM station_tabs WHERE link_id = ?1 AND unlinked_at IS NULL ORDER BY rowid`).bind(linkId).all<TabRow>()
  return r.results
}

export async function getTasks(db: D1Database, linkId: string): Promise<TaskRow[]> {
  const r = await db.prepare(`SELECT * FROM station_tasks WHERE link_id = ?1`).bind(linkId).all<TaskRow>()
  return r.results
}

export function baseOf(row: TaskRow | undefined): SyncedBase | null {
  if (!row?.base_json) return null
  return JSON.parse(row.base_json) as SyncedBase
}

export async function getNames(db: D1Database): Promise<Map<string, number>> {
  const r = await db.prepare(`SELECT name, bc_person_id FROM station_names`).all<{ name: string; bc_person_id: number }>()
  return new Map(r.results.map((n) => [n.name, n.bc_person_id]))
}

export function saveTaskStatement(
  db: D1Database,
  t: {
    uid: string
    linkId: string
    googleSheetId: number
    level: 0 | 1
    parentUid: string | null
    bcId: number | null
    base: SyncedBase | null
    assignFromSheet?: boolean
  },
  at: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO station_tasks (uid, link_id, google_sheet_id, level, parent_uid, bc_id, base_json, assign_from_sheet, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT (uid) DO UPDATE SET link_id = excluded.link_id, google_sheet_id = excluded.google_sheet_id, parent_uid = excluded.parent_uid,
         bc_id = COALESCE(excluded.bc_id, station_tasks.bc_id), base_json = COALESCE(excluded.base_json, station_tasks.base_json),
         assign_from_sheet = excluded.assign_from_sheet, updated_at = excluded.updated_at`,
    )
    .bind(t.uid, t.linkId, t.googleSheetId, t.level, t.parentUid, t.bcId, t.base ? JSON.stringify(t.base) : null, t.assignFromSheet === false ? 0 : 1, at)
}

export function logStatement(
  db: D1Database,
  e: { linkId: string; direction: 'to_basecamp' | 'to_sheet'; action: string; taskUid?: string | null; detail?: unknown },
  at: string,
): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO station_log (link_id, at, direction, action, task_uid, detail_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
    .bind(e.linkId, at, e.direction, e.action, e.taskUid ?? null, e.detail === undefined ? null : JSON.stringify(e.detail))
}

/** What a run saw, for `recordAlerts`. */
export interface AlertScope {
  /** The run read every tab it could; false when it stopped early (nothing it did not see is resolved). */
  complete: boolean
  /** Tabs the run skipped (missing header, read empty, deleted): their problems stay as they were. */
  skippedTabs?: ReadonlySet<string>
}

/** Problems raised once, by the run where they happened: kept open until emailed. */
function isEvent(alert: StationAlert): boolean {
  return alert.kind === 'rows_held' && (alert.code === 'people_reverted' || alert.code === 'role_missing')
}

/**
 * Records the problems seen in this run for a link: new ones open (a problem
 * that comes back after it was resolved is new: emailed again), known ones
 * stay open (not emailed again), and the link's problems the run looked for
 * and did not see are resolved. Name alerts are global (one name, every link):
 * resolved when the name is mapped, whatever link reported it.
 */
export async function recordAlerts(
  db: D1Database,
  linkId: string,
  alerts: readonly StationAlert[],
  mappedNames: ReadonlySet<string>,
  at: string,
  scope: AlertScope,
): Promise<void> {
  const keys = new Set<string>()
  const statements: D1PreparedStatement[] = []
  for (const alert of alerts) {
    const key = alertKey(alert)
    if (keys.has(key)) continue
    keys.add(key)
    statements.push(
      db
        .prepare(
          `INSERT INTO station_alerts (key, link_id, alert_json, first_seen, last_seen) VALUES (?1, ?2, ?3, ?4, ?4)
           ON CONFLICT (key) DO UPDATE SET alert_json = excluded.alert_json, last_seen = excluded.last_seen,
             first_seen = CASE WHEN station_alerts.resolved_at IS NULL THEN station_alerts.first_seen ELSE excluded.first_seen END,
             emailed_at = CASE WHEN station_alerts.resolved_at IS NULL THEN station_alerts.emailed_at ELSE NULL END,
             resolved_at = NULL`,
        )
        .bind(key, linkId, JSON.stringify(alert), at),
    )
  }
  const open = await db
    .prepare(`SELECT key, alert_json, emailed_at FROM station_alerts WHERE resolved_at IS NULL AND (link_id = ?1 OR key LIKE 'name_unmapped:%')`)
    .bind(linkId)
    .all<{ key: string; alert_json: string; emailed_at: string | null }>()
  for (const row of open.results) {
    if (keys.has(row.key)) continue
    const alert = JSON.parse(row.alert_json) as StationAlert
    let gone: boolean
    if (alert.kind === 'name_unmapped') gone = mappedNames.has(alert.name)
    else if (alert.linkId !== linkId || !scope.complete) gone = false
    else if ('tab' in alert && scope.skippedTabs?.has(alert.tab)) gone = false
    else gone = !(isEvent(alert) && row.emailed_at === null)
    if (gone) statements.push(db.prepare(`UPDATE station_alerts SET resolved_at = ?2 WHERE key = ?1`).bind(row.key, at))
  }
  if (statements.length > 0) await db.batch(statements)
}
