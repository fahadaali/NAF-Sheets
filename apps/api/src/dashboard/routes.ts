// Routes of packages/shared/src/api-dashboard.ts.
//
//   GET  /api/workbooks/:id/dashboard                         figures + widgets
//   POST /api/workbooks/:id/dashboard/preview                 one configuration, not stored
//   POST /api/workbooks/:id/dashboard/widgets                 add (201)
//   PUT  /api/workbooks/:id/dashboard/widgets/order           reorder
//   PUT  /api/workbooks/:id/dashboard/widgets/:widgetId       edit
//   POST /api/workbooks/:id/dashboard/widgets/:widgetId/remove   remove ({ confirmed: true })
//   GET  /api/appearance                                      palette overrides (everyone signed in)
//   PUT  /api/admin/appearance                                palette overrides (platform admins)
//
// Reading follows opening the workbook exactly: a workbook nobody may open
// answers 404 (never revealing it exists). A `viewer` reads and is refused
// with 403 on every write, whatever the UI shows (CLAUDE.md §2).

import { Hono } from 'hono'
import type { Context } from 'hono'
import type {
  AppearanceResponse,
  DashboardActivity,
  DashboardResponse,
  DashboardSync,
  SyncState,
  WidgetListResponse,
  WidgetResponse,
  WidgetResult,
} from '@naf-sheets/shared'
import { MAX_WIDGETS_PER_WORKBOOK, normalizePalette } from '@naf-sheets/shared'
import type { Caller, WorkbookAccess } from '../access'
import { canWrite, resolveAccess } from '../access'
import { auditStatement } from '../audit'
import type { AppEnv } from '../auth'
import { getWorkbookRow } from '../db'
import type { Env } from '../env'
import { ApiFailure } from '../errors'
import { dayOf } from '../phase7/internal-api'
import { callerOf, isPlainObject, nowIso, readJson } from '../request'
import { loadWorkbookState } from '../sync/state'
import type { WorkbookState } from '../sync/state'
import { getWorkbookSync, isLinked } from '../sync/store'
import type { WorkbookSyncRow } from '../sync/store'
import { readAppearance, writeAppearance } from './appearance'
import { computeAutomatic, evaluateWidget, LIST_LIMIT, TIMELINE_LIMIT, weekOf } from './compute'
import { DashboardFailure, onDashboardError } from './errors'
import { liveWidgets, parseWidgetConfig, widgetById } from './widgets'

export interface DashboardRouteOptions {
  /** "Now", for tests. */
  now?: () => Date
}

interface Loaded {
  caller: Caller
  access: WorkbookAccess
  wb: WorkbookSyncRow
}

async function load(c: Context<AppEnv>): Promise<Loaded> {
  const caller = callerOf(c)
  const id = c.req.param('id') ?? ''
  if (id === '' || id.length > 128) throw new ApiFailure(404, 'workbook_not_found')
  const row = await getWorkbookRow(c.env.DB, caller.id, id)
  const access = row ? resolveAccess(caller, row.owner_id, row.member_role) : null
  if (!row || access === null) throw new ApiFailure(404, 'workbook_not_found')
  const wb = await getWorkbookSync(c.env.DB, id)
  if (!wb) throw new ApiFailure(404, 'workbook_not_found')
  return { caller, access, wb }
}

function requireWrite(loaded: Loaded): void {
  if (!canWrite(loaded.access)) throw new DashboardFailure('forbidden_write')
}

async function stateOf(env: Env, wb: WorkbookSyncRow): Promise<WorkbookState> {
  const state = await loadWorkbookState(env, wb)
  if (!state) {
    console.error(`dashboard: snapshot unreadable for workbook ${wb.id}`)
    throw new DashboardFailure('snapshot_missing')
  }
  return state
}

/** 1-based header row of a sheet (D1), 1 for a sheet D1 does not know. */
const headerRows = (state: WorkbookState) => (univerSheetId: string) => state.sheets.find((s) => s.univer_sheet_id === univerSheetId)?.header_row ?? 1

const RANK: Record<SyncState, number> = { unlinked: 0, synced: 1, pending: 2, conflict: 3, error: 4 }

async function syncOf(db: D1Database, wb: WorkbookSyncRow): Promise<DashboardSync> {
  const { results } = await db
    .prepare(
      `SELECT t.sync_state AS state, COUNT(*) AS n FROM tasks t JOIN sheets s ON s.id = t.sheet_id
       WHERE s.workbook_id = ?1 AND s.sync_mode = 'synced' AND t.trashed_at IS NULL GROUP BY t.sync_state`,
    )
    .bind(wb.id)
    .all<{ state: SyncState; n: number }>()
  const counts = { pending: 0, error: 0, conflict: 0 }
  let worst: SyncState = 'synced'
  for (const r of results) {
    if (r.state === 'pending' || r.state === 'error' || r.state === 'conflict') counts[r.state] += r.n
    if ((RANK[r.state] ?? 0) > RANK[worst]) worst = r.state
  }
  return { state: isLinked(wb) ? worst : 'unlinked', lastSuccessAt: wb.last_sync_success_at, counts }
}

/** Newest sync_log entries of the workbook. Webhook deliveries the platform ignored are left out. OPEN (D5). */
async function activityOf(db: D1Database, wb: WorkbookSyncRow, rows: Map<string, { title: string; link: DashboardActivity['link'] }>): Promise<DashboardActivity[]> {
  const { results } = await db
    .prepare(
      `SELECT l.id, l.at, l.direction, l.action, l.field, l.status, l.task_uid, m.display_name AS actor_name
       FROM sync_log l LEFT JOIN members m ON m.user_id = l.actor
       WHERE l.workbook_id = ?1 AND l.status <> 'ignored'
       ORDER BY l.at DESC, l.id DESC LIMIT 20`,
    )
    .bind(wb.id)
    .all<{ id: number; at: string; direction: 'out' | 'in'; action: string; field: string | null; status: string; task_uid: string | null; actor_name: string | null }>()
  return results.map((r) => {
    const row = r.task_uid ? rows.get(r.task_uid) : undefined
    return {
      id: r.id,
      at: r.at,
      direction: r.direction,
      action: r.action,
      field: r.field,
      status: r.status,
      actorName: r.actor_name,
      taskTitle: row?.title ?? null,
      link: row?.link ?? null,
    }
  })
}

export function dashboardWorkbookRoutes(options: DashboardRouteOptions = {}): Hono<AppEnv> {
  const now = options.now ?? (() => new Date())
  const routes = new Hono<AppEnv>()
  routes.onError(onDashboardError)

  routes.get('/:id/dashboard', async (c) => {
    const loaded = await load(c)
    const state = await stateOf(c.env, loaded.wb)
    const today = dayOf(now())
    const week = weekOf(today)
    const auto = computeAutomatic(state, today)
    const widgets = await liveWidgets(c.env.DB, loaded.wb.id)
    const headerRowOf = headerRows(state)
    const results: WidgetResult[] = widgets.map((w) => evaluateWidget(state.snapshot, w, headerRowOf, w.id))
    const { rowsByUid, ...figures } = auto
    return c.json<DashboardResponse>({
      workbookId: loaded.wb.id,
      version: state.version,
      asOf: today,
      weekStart: week.start,
      weekEnd: week.end,
      canEdit: canWrite(loaded.access),
      ...figures,
      listLimit: LIST_LIMIT,
      timelineLimit: TIMELINE_LIMIT,
      activity: await activityOf(c.env.DB, loaded.wb, rowsByUid),
      sync: await syncOf(c.env.DB, loaded.wb),
      widgets,
      results,
    })
  })

  // A configuration computed without being stored (the widget dialog's live preview). Reading only.
  routes.post('/:id/dashboard/preview', async (c) => {
    const loaded = await load(c)
    const config = parseWidgetConfig(await readJson(c))
    if (!config) throw new DashboardFailure('invalid_widget')
    const state = await stateOf(c.env, loaded.wb)
    return c.json<WidgetResult>(evaluateWidget(state.snapshot, config, headerRows(state)))
  })

  routes.post('/:id/dashboard/widgets', async (c) => {
    const loaded = await load(c)
    requireWrite(loaded)
    const config = parseWidgetConfig(await readJson(c))
    if (!config) throw new DashboardFailure('invalid_widget')
    const db = c.env.DB
    const existing = await liveWidgets(db, loaded.wb.id)
    if (existing.length >= MAX_WIDGETS_PER_WORKBOOK) throw new DashboardFailure('widget_limit')
    const id = crypto.randomUUID()
    const at = nowIso()
    await db.batch([
      db
        .prepare(
          `INSERT INTO dashboard_widgets (id, workbook_id, position, config_json, created_by, created_at, updated_by, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?5, ?6)`,
        )
        .bind(id, loaded.wb.id, existing.length, JSON.stringify(config), loaded.caller.id, at),
      auditStatement(db, { actorId: loaded.caller.id, action: 'dashboard.widget.create', entityType: 'dashboard_widget', entityId: id, workbookId: loaded.wb.id, details: config }, at),
    ])
    const widget = { id, position: existing.length, updatedAt: at, ...config }
    const state = await stateOf(c.env, loaded.wb)
    return c.json<WidgetResponse>({ widget, result: evaluateWidget(state.snapshot, widget, headerRows(state), id) }, 201)
  })

  // Registered before '/:widgetId' so "order" is never read as a widget id.
  routes.put('/:id/dashboard/widgets/order', async (c) => {
    const loaded = await load(c)
    requireWrite(loaded)
    const body = await readJson(c)
    const ids = isPlainObject(body) && Array.isArray(body.ids) ? body.ids : null
    const db = c.env.DB
    const current = await liveWidgets(db, loaded.wb.id)
    const known = new Set(current.map((w) => w.id))
    if (!ids || ids.length !== current.length || new Set(ids).size !== ids.length || !ids.every((id) => typeof id === 'string' && known.has(id))) {
      throw new DashboardFailure('invalid_order')
    }
    const at = nowIso()
    await db.batch([
      ...(ids as string[]).map((id, position) =>
        db.prepare(`UPDATE dashboard_widgets SET position = ?3, updated_by = ?4, updated_at = ?5 WHERE workbook_id = ?1 AND id = ?2 AND removed_at IS NULL`).bind(loaded.wb.id, id, position, loaded.caller.id, at),
      ),
      auditStatement(db, { actorId: loaded.caller.id, action: 'dashboard.widget.reorder', entityType: 'workbook', entityId: loaded.wb.id, workbookId: loaded.wb.id, details: { ids } }, at),
    ])
    return c.json<WidgetListResponse>({ widgets: await liveWidgets(db, loaded.wb.id) })
  })

  routes.put('/:id/dashboard/widgets/:widgetId', async (c) => {
    const loaded = await load(c)
    requireWrite(loaded)
    const widgetId = c.req.param('widgetId') ?? ''
    const config = parseWidgetConfig(await readJson(c))
    if (!config) throw new DashboardFailure('invalid_widget')
    const db = c.env.DB
    const before = await widgetById(db, loaded.wb.id, widgetId)
    if (!before) throw new DashboardFailure('widget_not_found')
    const at = nowIso()
    await db.batch([
      db
        .prepare(`UPDATE dashboard_widgets SET config_json = ?3, updated_by = ?4, updated_at = ?5 WHERE workbook_id = ?1 AND id = ?2 AND removed_at IS NULL`)
        .bind(loaded.wb.id, widgetId, JSON.stringify(config), loaded.caller.id, at),
      auditStatement(db, { actorId: loaded.caller.id, action: 'dashboard.widget.update', entityType: 'dashboard_widget', entityId: widgetId, workbookId: loaded.wb.id, details: config }, at),
    ])
    const widget = { ...config, id: widgetId, position: before.position, updatedAt: at }
    const state = await stateOf(c.env, loaded.wb)
    return c.json<WidgetResponse>({ widget, result: evaluateWidget(state.snapshot, widget, headerRows(state), widgetId) })
  })

  routes.post('/:id/dashboard/widgets/:widgetId/remove', async (c) => {
    const loaded = await load(c)
    requireWrite(loaded)
    const widgetId = c.req.param('widgetId') ?? ''
    const body = await readJson(c)
    if (!isPlainObject(body) || body.confirmed !== true) throw new DashboardFailure('widget_not_confirmed')
    const db = c.env.DB
    const before = await widgetById(db, loaded.wb.id, widgetId)
    if (!before) throw new DashboardFailure('widget_not_found')
    const at = nowIso()
    // Kept, not deleted: the row stays with removed_at (CLAUDE.md §3).
    await db.batch([
      db.prepare(`UPDATE dashboard_widgets SET removed_at = ?3, removed_by = ?4 WHERE workbook_id = ?1 AND id = ?2 AND removed_at IS NULL`).bind(loaded.wb.id, widgetId, at, loaded.caller.id),
      auditStatement(db, { actorId: loaded.caller.id, action: 'dashboard.widget.remove', entityType: 'dashboard_widget', entityId: widgetId, workbookId: loaded.wb.id, details: { title: before.title } }, at),
    ])
    const widgets = await liveWidgets(db, loaded.wb.id)
    // Close the gap the removal left.
    await db.batch(widgets.map((w, i) => db.prepare(`UPDATE dashboard_widgets SET position = ?3 WHERE workbook_id = ?1 AND id = ?2`).bind(loaded.wb.id, w.id, i)))
    return c.json<WidgetListResponse>({ widgets })
  })

  return routes
}

export function appearanceRoutes(): { read: Hono<AppEnv>; admin: Hono<AppEnv> } {
  const read = new Hono<AppEnv>()
  read.onError(onDashboardError)
  read.get('/', async (c) => {
    callerOf(c)
    return c.json<AppearanceResponse>(await readAppearance(c.env.SETTINGS))
  })

  const admin = new Hono<AppEnv>()
  admin.onError(onDashboardError)
  admin.put('/', async (c) => {
    const caller = callerOf(c)
    if (caller.role !== 'admin') throw new DashboardFailure('admin_only')
    const body = await readJson(c)
    const palette = isPlainObject(body) ? normalizePalette(body.palette) : null
    if (!palette) throw new DashboardFailure('invalid_palette')
    const at = nowIso()
    const saved = await writeAppearance(c.env.SETTINGS, palette, caller.id, at)
    await auditStatement(c.env.DB, { actorId: caller.id, action: 'settings.appearance', entityType: 'settings', entityId: 'appearance', workbookId: null, details: { palette } }, at).run()
    return c.json<AppearanceResponse>(saved)
  })
  return { read, admin }
}
