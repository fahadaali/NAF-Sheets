// The station's HTTP surface (docs/station-plan.md §6).
//
// Public: POST /webhooks/google/:secret — Drive push notifications.
// Signed in, under /api/station:
//   GET    /links                     every link with its state and open problems
//   GET    /inspect?source=…          a spreadsheet as the service account sees it (wizard)
//   GET    /projects                  Basecamp projects (wizard)
//   POST   /links                     link a spreadsheet's tabs to a project (admin)
//   GET    /links/:id                 a link, its tabs, problems and recent history
//   PATCH  /links/:id                 pause / resume, roles tab (admin)
//   DELETE /links/:id                 unlink: stops syncing; nothing deleted in the file or Basecamp (admin)
//   POST   /links/:id/sync            «مزامنة الآن» (admin)
//   GET    /names                     the name directory, unmapped names, Basecamp people
//   PUT    /names                     map a name to a person (admin)
//   DELETE /names?name=…              unmap a name (admin)
// Every error is `{ ok: false, error, message }` with an Arabic message.

import { Hono, type Context } from 'hono'
import { findColumns, readTab, readRoles, type CellValue } from '@naf-sheets/station-sheet'
import { withServiceToken } from '../basecamp-link'
import type { AppEnv } from '../auth'
import { callerOf, readJson, isPlainObject } from '../request'
import { defaultSyncDeps, readClient, syncContext, type SyncDeps } from '../sync/deps'
import { ensureProjectWebhook } from '../sync/inbound/webhooks'
import { webhookSecret } from '../sync/inbound/webhooks'
import { GoogleError, googleErrorMessage } from './google'
import { ensureChannel, googleFor, requestRun, type StationDeps } from './runner'
import { getNames } from './store'

const ADMIN_ONLY = 'هذا الإجراء مقصور على مسؤول المنصة. اطلبه من مسؤول المنصة.'

function fail(c: Context<AppEnv>, status: 400 | 403 | 404 | 409 | 503, error: string, message: string): Response {
  return c.json({ ok: false, error, message }, status)
}

function isAdmin(c: Context<AppEnv>): boolean {
  return callerOf(c).role === 'admin'
}

/** A Google Sheets link or a bare id → the spreadsheet id. */
export function spreadsheetIdOf(source: string): string | null {
  const s = source.trim()
  if (/^[A-Za-z0-9_-]{25,}$/.test(s)) return s
  const m = /\/spreadsheets\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{25,})/.exec(s)
  return m ? m[1]! : null
}

export function stationWebhookRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()
  routes.post('/google/:secret', async (c) => {
    const secret = c.req.param('secret')
    const link = await c.env.DB.prepare(`SELECT id FROM station_links WHERE notify_secret = ?1`).bind(secret).first<{ id: string }>()
    // Unknown channel: 404 makes Drive stop sending to it.
    if (!link) return c.json({ ok: false }, 404)
    // `sync` is the handshake sent when the channel opens; nothing changed yet.
    if (c.req.header('X-Goog-Resource-State') !== 'sync') await requestRun(c.env, link.id, 'drive')
    return c.json({ ok: true })
  })
  return routes
}

export function stationRoutes(depsIn?: StationDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()
  const deps = (): StationDeps => depsIn ?? defaultSyncDeps()
  const google = (c: Context<AppEnv>) => deps().google ?? googleFor(c.env, deps())

  // What the station needs before a link can work (§5): the Basecamp sync
  // account (an admin connects it at /auth/basecamp/start?service=1), the
  // Google service account key, and the email key. Never a secret's value.
  routes.get('/status', async (c) => {
    callerOf(c)
    const account = (c.env as { BASECAMP_ACCOUNT_ID?: string }).BASECAMP_ACCOUNT_ID?.trim() ?? ''
    const sync = await c.env.DB.prepare(
      `SELECT i.status, i.bc_person_id, p.name FROM integrations i LEFT JOIN bc_account_people_cache p ON p.bc_person_id = i.bc_person_id
       WHERE i.provider = 'basecamp' AND i.account_id = ?1`,
    )
      .bind(account)
      .first<{ status: string; bc_person_id: number | null; name: string | null }>()
    let serviceAccount: string | null = null
    try {
      serviceAccount = google(c).serviceAccountEmail
    } catch {
      serviceAccount = null
    }
    return c.json({
      ok: true,
      basecamp: sync ? { status: sync.status, personId: sync.bc_person_id, name: sync.name } : null,
      google: serviceAccount,
      email: Boolean(c.env.RESEND_API_KEY),
    })
  })

  routes.get('/links', async (c) => {
    callerOf(c)
    const links = await c.env.DB.prepare(
      `SELECT l.id, l.title, l.spreadsheet_id, l.bc_project_id, l.state, l.last_sync_at, l.last_error,
              (SELECT COUNT(*) FROM station_tabs t WHERE t.link_id = l.id) AS tabs,
              (SELECT COUNT(*) FROM station_alerts a WHERE a.link_id = l.id AND a.resolved_at IS NULL) AS problems
       FROM station_links l ORDER BY l.created_at`,
    ).all()
    return c.json({ ok: true, links: links.results })
  })

  routes.get('/inspect', async (c) => {
    callerOf(c)
    const id = spreadsheetIdOf(c.req.query('source') ?? '')
    if (!id) return fail(c, 400, 'invalid_source', 'الرابط ليس رابط ملف Google Sheets. انسخ رابط الملف من شريط العنوان ثم أعد المحاولة.')
    try {
      const g = google(c)
      const meta = await g.spreadsheet(id)
      const values = await g.tabValues(
        id,
        meta.tabs.map((t) => t.title),
      )
      const rolesTab = c.req.query('rolesTab') ?? 'المسميات'
      const { roles } = readRoles((values.get(rolesTab) ?? []) as CellValue[][])
      const people = await getNames(c.env.DB)
      const tabs = meta.tabs.map((t) => {
        const rows = (values.get(t.title) ?? []) as CellValue[][]
        const columns = findColumns(rows[0] ?? [])
        if (!columns.ok) return { sheetId: t.sheetId, title: t.title, linkable: false, reason: columns.message }
        let n = 0
        const read = readTab({ values: rows, columns: columns.columns, roles, people, identities: new Map(), newUid: () => `preview-${++n}`, sheetId: String(t.sheetId), changedAt: null })
        return {
          sheetId: t.sheetId,
          title: t.title,
          linkable: true,
          todos: read.rows.filter((r) => r.level === 0).length,
          subtasks: read.rows.filter((r) => r.level === 1).length,
          held: read.issues.filter((i) => i.blocking).map((i) => i.message),
        }
      })
      return c.json({ ok: true, spreadsheetId: id, title: meta.title, serviceAccount: g.serviceAccountEmail, hasRolesTab: values.has(rolesTab) && meta.tabs.some((t) => t.title === rolesTab), tabs })
    } catch (error) {
      if (error instanceof GoogleError) return fail(c, error.code === 'file_not_accessible' ? 404 : 503, error.code, googleErrorMessage(error.code, safeEmail(c)))
      throw error
    }
  })

  routes.get('/projects', async (c) => {
    callerOf(c)
    const ctx = syncContext(c.env, deps())
    const projects = await withServiceToken(ctx, (token) => readClient(ctx).projects.list(token).all())
    return c.json({
      ok: true,
      projects: projects.map((p) => ({ id: p.id, name: p.name, todosetId: todosetOf(p) })),
    })
  })

  routes.post('/links', async (c) => {
    if (!isAdmin(c)) return fail(c, 403, 'admin_only', ADMIN_ONLY)
    const body = await readJson(c)
    if (!isPlainObject(body)) return fail(c, 400, 'invalid_link', 'الطلب غير صالح: أرسل رابط الملف ورقم المشروع والتبويبات المختارة.')
    const id = spreadsheetIdOf(String(body.source ?? ''))
    const projectId = Number(body.bcProjectId)
    const tabIds = Array.isArray(body.tabs) ? body.tabs.map(Number).filter(Number.isInteger) : []
    const rolesTab = typeof body.rolesTab === 'string' && body.rolesTab.trim() !== '' ? body.rolesTab.trim() : 'المسميات'
    if (!id || !Number.isInteger(projectId) || tabIds.length === 0) {
      return fail(c, 400, 'invalid_link', 'الطلب غير صالح: أرسل رابط الملف ورقم المشروع وتبويباً واحداً على الأقل.')
    }
    const g = google(c)
    let meta: Awaited<ReturnType<typeof g.spreadsheet>>
    try {
      meta = await g.spreadsheet(id)
    } catch (error) {
      if (error instanceof GoogleError) return fail(c, 404, error.code, googleErrorMessage(error.code, safeEmail(c)))
      throw error
    }
    const chosen = meta.tabs.filter((t) => tabIds.includes(t.sheetId))
    if (chosen.length !== tabIds.length) return fail(c, 400, 'unknown_tab', 'بعض التبويبات المختارة لم تعد في الملف. حدّث الصفحة ثم اختر من جديد.')
    const taken = await c.env.DB.prepare(
      `SELECT t.title FROM station_tabs t JOIN station_links l ON l.id = t.link_id WHERE l.spreadsheet_id = ?1 AND t.google_sheet_id IN (${tabIds.map(() => '?').join(',')})`,
    )
      .bind(id, ...tabIds)
      .all<{ title: string }>()
    if (taken.results.length > 0) {
      return fail(c, 409, 'tab_already_linked', `التبويب «${taken.results[0]!.title}» مربوط في ربط آخر. التبويب الواحد يُربط مرة واحدة.`)
    }
    const ctx = syncContext(c.env, deps())
    const project = await withServiceToken(ctx, (token) => readClient(ctx).projects.get(token, projectId))
    const todosetId = todosetOf(project)
    if (todosetId === null) return fail(c, 409, 'todos_disabled', `أداة المهام غير مفعّلة في مشروع «${project.name}» في Basecamp. فعّلها من إعدادات المشروع ثم أعد المحاولة.`)

    const linkId = crypto.randomUUID()
    const at = new Date(deps().now()).toISOString()
    const me = callerOf(c).id
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO station_links (id, spreadsheet_id, title, bc_project_id, bc_todoset_id, roles_tab, notify_secret, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
      ).bind(linkId, id, meta.title, projectId, todosetId, rolesTab, webhookSecret(), me, at),
      ...chosen.map((t) => c.env.DB.prepare(`INSERT INTO station_tabs (link_id, google_sheet_id, title) VALUES (?1, ?2, ?3)`).bind(linkId, t.sheetId, t.title)),
      c.env.DB.prepare(
        `INSERT INTO audit_log (at, actor_id, action, entity_type, entity_id, workbook_id, details_json) VALUES (?1, ?2, 'station.link.create', 'station_link', ?3, NULL, ?4)`,
      ).bind(at, me, linkId, JSON.stringify({ spreadsheetId: id, bcProjectId: projectId, tabs: tabIds })),
    ])
    await ensureProjectWebhook(c.env, { workbookId: `station:${linkId}`, bcProjectId: projectId }, deps())
    await ensureChannel(c.env, linkId, id, g as Parameters<typeof ensureChannel>[3], deps().now()).catch(() => undefined)
    await requestRun(c.env, linkId, 'manual')
    return c.json({ ok: true, id: linkId }, 201)
  })

  routes.get('/links/:id', async (c) => {
    callerOf(c)
    const id = c.req.param('id')
    const link = await c.env.DB.prepare(`SELECT id, title, spreadsheet_id, bc_project_id, roles_tab, state, last_sync_at, last_error, created_at FROM station_links WHERE id = ?1`)
      .bind(id)
      .first()
    if (!link) return fail(c, 404, 'link_not_found', 'لم يُعثر على هذا الربط، فربما فُكّ. حدّث الصفحة.')
    const [tabs, problems, log] = await Promise.all([
      c.env.DB.prepare(`SELECT google_sheet_id, title, bc_todolist_id FROM station_tabs WHERE link_id = ?1 ORDER BY rowid`).bind(id).all(),
      c.env.DB.prepare(`SELECT key, alert_json, first_seen, emailed_at FROM station_alerts WHERE link_id = ?1 AND resolved_at IS NULL ORDER BY first_seen`).bind(id).all<{ key: string; alert_json: string; first_seen: string; emailed_at: string | null }>(),
      c.env.DB.prepare(`SELECT at, direction, action, task_uid, detail_json FROM station_log WHERE link_id = ?1 ORDER BY id DESC LIMIT 50`).bind(id).all(),
    ])
    return c.json({
      ok: true,
      link,
      tabs: tabs.results,
      problems: problems.results.map((p) => ({ key: p.key, alert: JSON.parse(p.alert_json), firstSeen: p.first_seen, emailedAt: p.emailed_at })),
      log: log.results,
    })
  })

  routes.patch('/links/:id', async (c) => {
    if (!isAdmin(c)) return fail(c, 403, 'admin_only', ADMIN_ONLY)
    const body = await readJson(c)
    if (!isPlainObject(body)) return fail(c, 400, 'invalid_change', 'الطلب غير صالح: أرسل «state» (active أو paused) أو «rolesTab».')
    const state = body.state === 'active' || body.state === 'paused' ? body.state : null
    const rolesTab = typeof body.rolesTab === 'string' && body.rolesTab.trim() !== '' ? body.rolesTab.trim() : null
    if (state === null && rolesTab === null) return fail(c, 400, 'invalid_change', 'الطلب غير صالح: أرسل «state» (active أو paused) أو «rolesTab».')
    const r = await c.env.DB.prepare(`UPDATE station_links SET state = COALESCE(?2, state), roles_tab = COALESCE(?3, roles_tab), updated_at = ?4 WHERE id = ?1`)
      .bind(c.req.param('id'), state, rolesTab, new Date(deps().now()).toISOString())
      .run()
    if (r.meta.changes !== 1) return fail(c, 404, 'link_not_found', 'لم يُعثر على هذا الربط، فربما فُكّ. حدّث الصفحة.')
    if (state !== 'paused') await requestRun(c.env, c.req.param('id'), 'manual')
    return c.json({ ok: true })
  })

  routes.delete('/links/:id', async (c) => {
    if (!isAdmin(c)) return fail(c, 403, 'admin_only', ADMIN_ONLY)
    const id = c.req.param('id')
    const channel = await c.env.DB.prepare(`SELECT channel_id, resource_id FROM station_channels WHERE link_id = ?1`).bind(id).first<{ channel_id: string; resource_id: string }>()
    const at = new Date(deps().now()).toISOString()
    const r = await c.env.DB.batch([
      c.env.DB.prepare(`DELETE FROM station_links WHERE id = ?1`).bind(id),
      c.env.DB.prepare(`UPDATE station_alerts SET resolved_at = ?2 WHERE link_id = ?1 AND resolved_at IS NULL`).bind(id, at),
      c.env.DB.prepare(
        `INSERT INTO audit_log (at, actor_id, action, entity_type, entity_id, workbook_id, details_json) VALUES (?1, ?2, 'station.link.delete', 'station_link', ?3, NULL, NULL)`,
      ).bind(at, callerOf(c).id, id),
    ])
    if (r[0]!.meta.changes !== 1) return fail(c, 404, 'link_not_found', 'لم يُعثر على هذا الربط، فربما فُكّ. حدّث الصفحة.')
    if (channel) {
      const g = google(c) as { stopChannel?: (ch: { id: string; resourceId: string }) => Promise<void> }
      await g.stopChannel?.({ id: channel.channel_id, resourceId: channel.resource_id }).catch(() => undefined)
    }
    return c.json({ ok: true })
  })

  routes.post('/links/:id/sync', async (c) => {
    if (!isAdmin(c)) return fail(c, 403, 'admin_only', ADMIN_ONLY)
    const link = await c.env.DB.prepare(`SELECT id FROM station_links WHERE id = ?1`).bind(c.req.param('id')).first()
    if (!link) return fail(c, 404, 'link_not_found', 'لم يُعثر على هذا الربط، فربما فُكّ. حدّث الصفحة.')
    await requestRun(c.env, c.req.param('id'), 'manual')
    return c.json({ ok: true }, 202)
  })

  routes.get('/names', async (c) => {
    callerOf(c)
    const names = await c.env.DB.prepare(`SELECT name, bc_person_id, source, updated_at FROM station_names ORDER BY name`).all()
    const open = await c.env.DB.prepare(`SELECT alert_json FROM station_alerts WHERE key LIKE 'name_unmapped:%' AND resolved_at IS NULL`).all<{ alert_json: string }>()
    const ctx = syncContext(c.env, deps())
    const people = await withServiceToken(ctx, (token) => readClient(ctx).people.listAll(token).all())
    return c.json({
      ok: true,
      names: names.results,
      unmapped: open.results.map((r) => JSON.parse(r.alert_json)),
      people: people.filter((p) => p.personable_type === undefined || p.personable_type === 'User').map((p) => ({ id: p.id, name: p.name })),
    })
  })

  routes.put('/names', async (c) => {
    if (!isAdmin(c)) return fail(c, 403, 'admin_only', ADMIN_ONLY)
    const body = await readJson(c)
    const name = isPlainObject(body) && typeof body.name === 'string' ? body.name.replace(/\s+/g, ' ').trim() : ''
    const person = isPlainObject(body) ? Number(body.bcPersonId) : NaN
    if (name === '' || !Number.isInteger(person)) return fail(c, 400, 'invalid_name', 'الطلب غير صالح: أرسل الاسم كما في «المسميات» والشخص المختار من Basecamp.')
    const at = new Date(deps().now()).toISOString()
    await c.env.DB.prepare(
      `INSERT INTO station_names (name, bc_person_id, source, updated_by, updated_at) VALUES (?1, ?2, 'manual', ?3, ?4)
       ON CONFLICT (name) DO UPDATE SET bc_person_id = excluded.bc_person_id, source = 'manual', updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
      .bind(name, person, callerOf(c).id, at)
      .run()
    // Rows held for this name resume now.
    const links = await c.env.DB.prepare(`SELECT id FROM station_links WHERE state = 'active'`).all<{ id: string }>()
    for (const l of links.results) await requestRun(c.env, l.id, 'manual')
    return c.json({ ok: true })
  })

  routes.delete('/names', async (c) => {
    if (!isAdmin(c)) return fail(c, 403, 'admin_only', ADMIN_ONLY)
    const name = (c.req.query('name') ?? '').trim()
    const r = await c.env.DB.prepare(`DELETE FROM station_names WHERE name = ?1`).bind(name).run()
    if (r.meta.changes !== 1) return fail(c, 404, 'name_not_found', 'هذا الاسم غير مربوط أصلاً. حدّث الصفحة.')
    return c.json({ ok: true })
  })

  function safeEmail(c: Context<AppEnv>): string | undefined {
    try {
      return google(c).serviceAccountEmail
    } catch {
      return undefined
    }
  }

  return routes
}

function todosetOf(project: { dock?: { name?: string; id?: number; enabled?: boolean }[] }): number | null {
  const tool = (project.dock ?? []).find((d) => d.name === 'todoset' && d.enabled !== false)
  return typeof tool?.id === 'number' ? tool.id : null
}

export type { SyncDeps }
