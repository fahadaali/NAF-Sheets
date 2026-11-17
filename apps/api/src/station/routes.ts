// The station's HTTP surface (docs/station-plan.md §6).
//
// Public: POST /webhooks/google/:secret — Drive push notifications.
// Signed in, under /api/station:
//   GET    /links                     every link with its state and open problems
//   GET    /inspect?source=…          a spreadsheet as the service account sees it (wizard, admin)
//   GET    /projects                  Basecamp projects (wizard, admin)
//   GET    /projects/:id/lists        the project's to-do lists, and which are linked already (wizard, admin)
//   POST   /preview                   what the first sync would do, per tab (wizard, admin; decision 10)
//   POST   /links                     link a spreadsheet's tabs to a project (admin)
//   GET    /links/:id                 a link, its tabs, problems and recent history
//   PATCH  /links/:id                 pause / resume, roles tab (admin)
//   DELETE /links/:id                 unlink: stops syncing; nothing deleted in the file, Basecamp or the
//                                     sync record, which linking the same file to the same project takes back (admin)
//   POST   /links/:id/sync            «مزامنة الآن» (admin)
//   POST   /links/:id/deleted/:n/restore     create a subtask deleted for good again from its snapshot (admin)
//   POST   /links/:id/conflicts/:n/restore   write a conflict's losing value back into the sheet (admin)
//   GET    /names                     the name directory, unmapped names, Basecamp people
//   PUT    /names                     map a name to a person (admin)
//   DELETE /names?name=…              unmap a name (admin)
// Every error is `{ ok: false, error, message }` with an Arabic message.

import { Hono, type Context } from 'hono'
import type { ApiErrorCode } from '@naf-sheets/shared'
import {
  FIRST_SYNC_REFERENCES,
  STATUS,
  findColumns,
  firstSyncPlan,
  readTab,
  readRoles,
  splitNames,
  textCell,
  type CellValue,
  type FirstSyncReference,
} from '@naf-sheets/station-sheet'
import type { FieldConflict, RemoteSubtask } from '@naf-sheets/shared'
import { recreateSubtaskFromSnapshot } from '@naf-sheets/sync-engine'
import { BasecampError, NotFoundError } from '@naf-sheets/basecamp'
import { withServiceToken } from '../basecamp-link'
import { onLinkError } from '../basecamp-link/errors'
import type { AppEnv } from '../auth'
import { callerOf, readJson, isPlainObject } from '../request'
import { defaultSyncDeps, readClient, syncContext, type SyncDeps } from './deps'
import { ensureProjectWebhook } from './basecamp-webhook'
import { webhookSecret } from './basecamp-webhook'
import { GoogleError, googleErrorMessage } from './google'
import { ensureChannel, googleFor, requestRun, type StationDeps } from './runner'
import { getNames } from './store'

const ADMIN_ONLY = 'هذا الإجراء مقصور على مسؤول المنصة. اطلبه من مسؤول المنصة.'

function fail(c: Context<AppEnv>, status: 400 | 403 | 404 | 409 | 503, error: ApiErrorCode, message: string): Response {
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

/** The wizard's choice for one tab: a new list (`listId` null) or a list of the project. */
interface TabChoice {
  sheetId: number
  listId: number | null
}

/** `tabs` as numbers (a new list each) or `{ sheetId, listId }`; null when malformed. */
function tabChoicesOf(value: unknown): TabChoice[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const out: TabChoice[] = []
  for (const v of value) {
    if (typeof v === 'number' && Number.isInteger(v)) out.push({ sheetId: v, listId: null })
    else if (isPlainObject(v) && Number.isInteger(v.sheetId) && (v.listId === undefined || v.listId === null || Number.isInteger(v.listId))) {
      out.push({ sheetId: v.sheetId as number, listId: (v.listId as number | null | undefined) ?? null })
    } else return null
  }
  return out
}

function referenceOf(value: unknown): FirstSyncReference {
  return FIRST_SYNC_REFERENCES.includes(value as FirstSyncReference) ? (value as FirstSyncReference) : 'merge'
}

export function stationWebhookRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()
  routes.post('/google/:secret', async (c) => {
    const secret = c.req.param('secret')
    const link = await c.env.DB.prepare(`SELECT id FROM station_links WHERE notify_secret = ?1 AND unlinked_at IS NULL`).bind(secret).first<{ id: string }>()
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

  // Failures the admin can act on keep their Arabic message: Google (no key, a
  // file not shared), Basecamp (a project gone, Basecamp down) and the sync
  // account (`LinkFailure`, e.g. not connected yet). Anything else is 500.
  routes.onError((error, c) => {
    if (error instanceof GoogleError) {
      return fail(c, error.code === 'file_not_accessible' ? 404 : 503, error.code, googleErrorMessage(error.code, safeEmail(c)))
    }
    if (error instanceof NotFoundError) {
      return fail(c, 404, 'basecamp_project_not_found', 'لم يُعثر على المشروع في Basecamp، أو ليس لحساب المزامنة وصول إليه. تأكّد من المشروع، أو أضف حساب المزامنة إليه في Basecamp.')
    }
    if (error instanceof BasecampError) {
      return fail(c, 503, 'basecamp_unavailable', 'تعذّر الوصول إلى Basecamp الآن، فلم يكتمل الطلب. أعد المحاولة بعد لحظات.')
    }
    return onLinkError(error, c)
  })

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
              (SELECT COUNT(*) FROM station_tabs t WHERE t.link_id = l.id AND t.unlinked_at IS NULL) AS tabs,
              (SELECT COUNT(*) FROM station_alerts a WHERE a.link_id = l.id AND a.resolved_at IS NULL) AS problems
       FROM station_links l WHERE l.unlinked_at IS NULL ORDER BY l.created_at`,
    ).all()
    return c.json({ ok: true, links: links.results })
  })

  routes.get('/inspect', async (c) => {
    if (!isAdmin(c)) return fail(c, 403, 'admin_only', ADMIN_ONLY)
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
    if (!isAdmin(c)) return fail(c, 403, 'admin_only', ADMIN_ONLY)
    const ctx = syncContext(c.env, deps())
    const projects = await withServiceToken(ctx, (token) => readClient(ctx).projects.list(token).all())
    return c.json({
      ok: true,
      projects: projects.map((p) => ({ id: p.id, name: p.name, todosetId: todosetOf(p) })),
    })
  })

  routes.get('/projects/:id/lists', async (c) => {
    if (!isAdmin(c)) return fail(c, 403, 'admin_only', ADMIN_ONLY)
    const ctx = syncContext(c.env, deps())
    const project = await withServiceToken(ctx, (token) => readClient(ctx).projects.get(token, Number(c.req.param('id'))))
    const todosetId = todosetOf(project)
    if (todosetId === null) return fail(c, 409, 'todos_disabled', `أداة المهام غير مفعّلة في مشروع «${project.name}» في Basecamp. فعّلها من إعدادات المشروع ثم أعد المحاولة.`)
    const lists = await withServiceToken(ctx, (token) => readClient(ctx).todolists.list(token, todosetId).all())
    const linked = await c.env.DB.prepare(`SELECT bc_todolist_id FROM station_tabs WHERE bc_todolist_id IS NOT NULL`).all<{ bc_todolist_id: number }>()
    const taken = new Set(linked.results.map((r) => r.bc_todolist_id))
    return c.json({ ok: true, lists: lists.map((l) => ({ id: l.id, name: l.name || l.title, linked: taken.has(l.id) })) })
  })

  // Decision 10: before linking, what the first sync would do in each tab —
  // matched by title, created in Basecamp, added to the sheet, left alone,
  // held. Reads only; nothing is written anywhere.
  routes.post('/preview', async (c) => {
    if (!isAdmin(c)) return fail(c, 403, 'admin_only', ADMIN_ONLY)
    const body = await readJson(c)
    const id = isPlainObject(body) ? spreadsheetIdOf(String(body.source ?? '')) : null
    const choices = isPlainObject(body) ? tabChoicesOf(body.tabs) : null
    if (!isPlainObject(body) || !id || !choices) return fail(c, 400, 'invalid_link', 'الطلب غير صالح: أرسل رابط الملف والتبويبات المختارة.')
    const reference = referenceOf(body.reference)
    const rolesTab = typeof body.rolesTab === 'string' && body.rolesTab.trim() !== '' ? body.rolesTab.trim() : 'المسميات'
    const g = google(c)
    const meta = await g.spreadsheet(id)
    const tabs = choices.map((t) => ({ ...t, title: meta.tabs.find((m) => m.sheetId === t.sheetId)?.title }))
    if (tabs.some((t) => t.title === undefined)) return fail(c, 400, 'unknown_tab', 'بعض التبويبات المختارة لم تعد في الملف. حدّث الصفحة ثم اختر من جديد.')
    const values = await g.tabValues(id, [...tabs.map((t) => t.title!), ...(meta.tabs.some((m) => m.title === rolesTab) ? [rolesTab] : [])])
    const { roles } = readRoles((values.get(rolesTab) ?? []) as CellValue[][])
    const people = await getNames(c.env.DB)
    const projectId = Number(body.bcProjectId)
    const ctx = Number.isInteger(projectId) ? syncContext(c.env, deps()) : null
    // As a run would: a name written exactly as a project person's maps itself (§6.1). In memory only.
    if (ctx) {
      const projectPeople = await withServiceToken(ctx, (token) => readClient(ctx).people.listProject(token, projectId).all())
      for (const name of new Set([...roles.values()].flatMap(splitNames))) {
        const same = projectPeople.filter((p) => p.name.trim() === name)
        if (!people.has(name) && same.length === 1) people.set(name, same[0]!.id)
      }
    }
    const out = []
    for (const t of tabs) {
      const rows = (values.get(t.title!) ?? []) as CellValue[][]
      const found = findColumns(rows[0] ?? [])
      if (!found.ok) {
        out.push({ sheetId: t.sheetId, title: t.title, ok: false, reason: found.message })
        continue
      }
      let n = 0
      const read = readTab({ values: rows, columns: found.columns, roles, people, identities: new Map(), newUid: () => `preview-${++n}`, sheetId: String(t.sheetId), changedAt: null })
      const held = new Set(read.issues.filter((i) => i.blocking).map((i) => i.row)).size
      const sendable = new Set(read.tasks.map((x) => x.uid))
      if (t.listId === null || !ctx) {
        out.push({ sheetId: t.sheetId, title: t.title, ok: true, matched: 0, changed: 0, toBasecamp: read.tasks.length, toSheet: 0, ignored: 0, held })
        continue
      }
      const { todos, subs } = await withServiceToken(ctx, async (token) => {
        const client = readClient(ctx)
        const listed = [...(await client.todos.list(token, t.listId!).all()), ...(await client.todos.list(token, t.listId!, { completed: true }).all())]
        const bySubs = new Map<number, RemoteSubtask[]>()
        for (const todo of listed) if (todo.subtasksCount > 0) bySubs.set(todo.id, await client.subtasks.list(token, todo.id).all())
        return { todos: listed, subs: bySubs }
      })
      const plan = firstSyncPlan(read.rows, todos, subs)
      const remoteOf = new Map<number, { dueOn: string | null; completed: boolean }>([...todos, ...[...subs.values()].flat()].map((x) => [x.id, x]))
      const localOf = new Map(read.tasks.map((x) => [x.uid, x]))
      const changed = plan.pairs.filter((p) => {
        const local = localOf.get(p.uid)
        const remote = remoteOf.get(p.bcId)
        return local && remote && (local.dueOn !== remote.dueOn || local.completed !== remote.completed)
      }).length
      out.push({
        sheetId: t.sheetId,
        title: t.title,
        ok: true,
        matched: plan.pairs.length,
        changed,
        toBasecamp: plan.fileOnly.filter((u) => sendable.has(u)).length,
        toSheet: reference === 'file' ? 0 : plan.basecampOnly.length,
        ignored: reference === 'file' ? plan.basecampOnly.length : 0,
        held,
      })
    }
    return c.json({ ok: true, reference, tabs: out })
  })

  routes.post('/links', async (c) => {
    if (!isAdmin(c)) return fail(c, 403, 'admin_only', ADMIN_ONLY)
    const body = await readJson(c)
    if (!isPlainObject(body)) return fail(c, 400, 'invalid_link', 'الطلب غير صالح: أرسل رابط الملف ورقم المشروع والتبويبات المختارة.')
    const id = spreadsheetIdOf(String(body.source ?? ''))
    const projectId = Number(body.bcProjectId)
    const choices = tabChoicesOf(body.tabs) ?? []
    const tabIds = choices.map((t) => t.sheetId)
    const reference = referenceOf(body.reference)
    const rolesTab = typeof body.rolesTab === 'string' && body.rolesTab.trim() !== '' ? body.rolesTab.trim() : 'المسميات'
    if (!id || !Number.isInteger(projectId) || tabIds.length === 0) {
      return fail(c, 400, 'invalid_link', 'الطلب غير صالح: أرسل رابط الملف ورقم المشروع وتبويباً واحداً على الأقل.')
    }
    const listIds = choices.map((t) => t.listId).filter((x): x is number => x !== null)
    if (new Set(listIds).size !== listIds.length) return fail(c, 400, 'invalid_link', 'اخترت القائمة نفسها لأكثر من تبويب. لكل تبويب قائمته.')
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
      `SELECT t.title FROM station_tabs t JOIN station_links l ON l.id = t.link_id
       WHERE l.spreadsheet_id = ?1 AND l.unlinked_at IS NULL AND t.unlinked_at IS NULL AND t.google_sheet_id IN (${tabIds.map(() => '?').join(',')})`,
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
    if (listIds.length > 0) {
      const lists = await withServiceToken(ctx, (token) => readClient(ctx).todolists.list(token, todosetId).all())
      const inProject = new Set(lists.map((l) => l.id))
      if (listIds.some((l) => !inProject.has(l))) return fail(c, 400, 'unknown_list', 'بعض القوائم المختارة لم تعد في المشروع. حدّث الصفحة ثم اختر من جديد.')
      const used = await c.env.DB.prepare(`SELECT bc_todolist_id FROM station_tabs WHERE bc_todolist_id IN (${listIds.map(() => '?').join(',')})`)
        .bind(...listIds)
        .all<{ bc_todolist_id: number }>()
      if (used.results.length > 0) return fail(c, 409, 'list_already_linked', 'القائمة المختارة مربوطة بتبويب آخر. القائمة الواحدة يغذّيها تبويب واحد؛ اختر قائمة أخرى أو «قائمة جديدة».')
    }
    const choiceOf = new Map(choices.map((t) => [t.sheetId, t]))

    const at = new Date(deps().now()).toISOString()
    const me = callerOf(c).id
    // The same file linked to the same project before and unlinked: take that
    // link back with its sync record, so no task is created twice (owner, 2026-11-17).
    const previous = await c.env.DB.prepare(
      `SELECT id FROM station_links WHERE spreadsheet_id = ?1 AND bc_project_id = ?2 AND unlinked_at IS NOT NULL ORDER BY unlinked_at DESC LIMIT 1`,
    )
      .bind(id, projectId)
      .first<{ id: string }>()
    if (previous) {
      const linkId = previous.id
      await c.env.DB.batch([
        c.env.DB.prepare(
          `UPDATE station_links SET unlinked_at = NULL, state = 'active', title = ?2, bc_todoset_id = ?3, roles_tab = ?4, lock_until = NULL, resync = 0, updated_at = ?5 WHERE id = ?1`,
        ).bind(linkId, meta.title, todosetId, rolesTab, at),
        // Tabs chosen now are linked (again); the others stay marked, with their lists kept.
        c.env.DB.prepare(`UPDATE station_tabs SET unlinked_at = ?2 WHERE link_id = ?1`).bind(linkId, at),
        ...chosen.map((t) =>
          c.env.DB.prepare(
            `INSERT INTO station_tabs (link_id, google_sheet_id, title, bc_todolist_id, first_sync) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (link_id, google_sheet_id) DO UPDATE SET title = excluded.title, unlinked_at = NULL`,
          ).bind(linkId, t.sheetId, t.title, choiceOf.get(t.sheetId)?.listId ?? null, choiceOf.get(t.sheetId)?.listId ? reference : null),
        ),
        c.env.DB.prepare(
          `INSERT INTO audit_log (at, actor_id, action, entity_type, entity_id, workbook_id, details_json) VALUES (?1, ?2, 'station.link.relink', 'station_link', ?3, NULL, ?4)`,
        ).bind(at, me, linkId, JSON.stringify({ spreadsheetId: id, bcProjectId: projectId, tabs: tabIds })),
      ])
      await ensureProjectWebhook(c.env, { workbookId: `station:${linkId}`, bcProjectId: projectId }, deps())
      await ensureChannel(c.env, linkId, id, g as Parameters<typeof ensureChannel>[3], deps().now()).catch(() => undefined)
      await requestRun(c.env, linkId, 'manual')
      return c.json({ ok: true, id: linkId, relinked: true }, 201)
    }

    const linkId = crypto.randomUUID()
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO station_links (id, spreadsheet_id, title, bc_project_id, bc_todoset_id, roles_tab, notify_secret, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
      ).bind(linkId, id, meta.title, projectId, todosetId, rolesTab, webhookSecret(), me, at),
      // A tab linked to an existing list is matched with it at its first run, by `first_sync` (decision 10).
      ...chosen.map((t) => {
        const listId = choiceOf.get(t.sheetId)?.listId ?? null
        return c.env.DB.prepare(`INSERT INTO station_tabs (link_id, google_sheet_id, title, bc_todolist_id, first_sync) VALUES (?1, ?2, ?3, ?4, ?5)`).bind(
          linkId,
          t.sheetId,
          t.title,
          listId,
          listId !== null ? reference : null,
        )
      }),
      c.env.DB.prepare(
        `INSERT INTO audit_log (at, actor_id, action, entity_type, entity_id, workbook_id, details_json) VALUES (?1, ?2, 'station.link.create', 'station_link', ?3, NULL, ?4)`,
      ).bind(at, me, linkId, JSON.stringify({ spreadsheetId: id, bcProjectId: projectId, tabs: choices, reference })),
    ])
    await ensureProjectWebhook(c.env, { workbookId: `station:${linkId}`, bcProjectId: projectId }, deps())
    await ensureChannel(c.env, linkId, id, g as Parameters<typeof ensureChannel>[3], deps().now()).catch(() => undefined)
    await requestRun(c.env, linkId, 'manual')
    return c.json({ ok: true, id: linkId }, 201)
  })

  routes.get('/links/:id', async (c) => {
    callerOf(c)
    const id = c.req.param('id')
    const link = await c.env.DB.prepare(
      `SELECT id, title, spreadsheet_id, bc_project_id, roles_tab, state, last_sync_at, last_error, created_at FROM station_links WHERE id = ?1 AND unlinked_at IS NULL`,
    )
      .bind(id)
      .first()
    if (!link) return fail(c, 404, 'link_not_found', 'لم يُعثر على هذا الربط، فربما فُكّ. حدّث الصفحة.')
    const [tabs, problems, log, deleted] = await Promise.all([
      c.env.DB.prepare(`SELECT google_sheet_id, title, bc_todolist_id FROM station_tabs WHERE link_id = ?1 AND unlinked_at IS NULL ORDER BY rowid`).bind(id).all(),
      c.env.DB.prepare(`SELECT key, alert_json, first_seen, emailed_at FROM station_alerts WHERE link_id = ?1 AND resolved_at IS NULL ORDER BY first_seen`).bind(id).all<{ key: string; alert_json: string; first_seen: string; emailed_at: string | null }>(),
      c.env.DB.prepare(`SELECT id, at, direction, action, task_uid, detail_json FROM station_log WHERE link_id = ?1 ORDER BY id DESC LIMIT 50`).bind(id).all(),
      c.env.DB.prepare(`SELECT rowid AS id, snapshot_json, deleted_at, restored_at FROM station_deleted WHERE link_id = ?1 ORDER BY deleted_at DESC LIMIT 50`)
        .bind(id)
        .all<{ id: number; snapshot_json: string; deleted_at: string; restored_at: string | null }>(),
    ])
    const account = (c.env as { BASECAMP_ACCOUNT_ID?: string }).BASECAMP_ACCOUNT_ID?.trim() ?? ''
    const projectUrl = /^[1-9]\d{0,15}$/.test(account) ? `https://3.basecamp.com/${account}/projects/${(link as { bc_project_id: number }).bc_project_id}` : null
    return c.json({
      ok: true,
      link,
      projectUrl,
      tabs: tabs.results,
      problems: problems.results.map((p) => ({ key: p.key, alert: JSON.parse(p.alert_json), firstSeen: p.first_seen, emailedAt: p.emailed_at })),
      log: log.results,
      deleted: deleted.results.map((d) => {
        const snapshot = JSON.parse(d.snapshot_json) as RemoteSubtask
        return { id: d.id, title: snapshot.title, dueOn: snapshot.dueOn, completed: snapshot.completed, deletedAt: d.deleted_at, restoredAt: d.restored_at }
      }),
    })
  })

  routes.patch('/links/:id', async (c) => {
    if (!isAdmin(c)) return fail(c, 403, 'admin_only', ADMIN_ONLY)
    const body = await readJson(c)
    if (!isPlainObject(body)) return fail(c, 400, 'invalid_change', 'الطلب غير صالح: أرسل «state» (active أو paused) أو «rolesTab».')
    const state = body.state === 'active' || body.state === 'paused' ? body.state : null
    const rolesTab = typeof body.rolesTab === 'string' && body.rolesTab.trim() !== '' ? body.rolesTab.trim() : null
    if (state === null && rolesTab === null) return fail(c, 400, 'invalid_change', 'الطلب غير صالح: أرسل «state» (active أو paused) أو «rolesTab».')
    const r = await c.env.DB.prepare(`UPDATE station_links SET state = COALESCE(?2, state), roles_tab = COALESCE(?3, roles_tab), updated_at = ?4 WHERE id = ?1 AND unlinked_at IS NULL`)
      .bind(c.req.param('id'), state, rolesTab, new Date(deps().now()).toISOString())
      .run()
    if (r.meta.changes !== 1) return fail(c, 404, 'link_not_found', 'لم يُعثر على هذا الربط، فربما فُكّ. حدّث الصفحة.')
    if (state !== 'paused') await requestRun(c.env, c.req.param('id'), 'manual')
    return c.json({ ok: true })
  })

  routes.delete('/links/:id', async (c) => {
    if (!isAdmin(c)) return fail(c, 403, 'admin_only', ADMIN_ONLY)
    const id = c.req.param('id')
    const link = await c.env.DB.prepare(`SELECT spreadsheet_id, bc_project_id FROM station_links WHERE id = ?1 AND unlinked_at IS NULL`)
      .bind(id)
      .first<{ spreadsheet_id: string; bc_project_id: number }>()
    if (!link) return fail(c, 404, 'link_not_found', 'لم يُعثر على هذا الربط، فربما فُكّ. حدّث الصفحة.')
    const channel = await c.env.DB.prepare(`SELECT channel_id, resource_id FROM station_channels WHERE link_id = ?1`).bind(id).first<{ channel_id: string; resource_id: string }>()
    const at = new Date(deps().now()).toISOString()
    await c.env.DB.batch([
      // Marked, not deleted: its tabs, tasks and history are kept for a later relink.
      c.env.DB.prepare(`UPDATE station_links SET unlinked_at = ?2, state = 'paused', lock_until = NULL, updated_at = ?2 WHERE id = ?1`).bind(id, at),
      // The channel is stopped below; a relink opens a new one at once.
      c.env.DB.prepare(`UPDATE station_channels SET expires_at = ?2 WHERE link_id = ?1`).bind(id, new Date(0).toISOString()),
      c.env.DB.prepare(`UPDATE station_alerts SET resolved_at = ?2 WHERE link_id = ?1 AND resolved_at IS NULL`).bind(id, at),
      c.env.DB.prepare(
        `INSERT INTO audit_log (at, actor_id, action, entity_type, entity_id, workbook_id, details_json) VALUES (?1, ?2, 'station.link.unlink', 'station_link', ?3, NULL, ?4)`,
      ).bind(at, callerOf(c).id, id, JSON.stringify({ spreadsheetId: link.spreadsheet_id, bcProjectId: link.bc_project_id })),
    ])
    if (channel) {
      // Best effort: without the Google key the channel simply lapses within a day.
      let g: ReturnType<typeof google> | null = null
      try {
        g = google(c)
      } catch {
        g = null
      }
      await g?.stopChannel?.({ id: channel.channel_id, resourceId: channel.resource_id }).catch(() => undefined)
    }
    return c.json({ ok: true })
  })

  routes.post('/links/:id/sync', async (c) => {
    if (!isAdmin(c)) return fail(c, 403, 'admin_only', ADMIN_ONLY)
    const link = await c.env.DB.prepare(`SELECT id FROM station_links WHERE id = ?1 AND unlinked_at IS NULL`).bind(c.req.param('id')).first()
    if (!link) return fail(c, 404, 'link_not_found', 'لم يُعثر على هذا الربط، فربما فُكّ. حدّث الصفحة.')
    await requestRun(c.env, c.req.param('id'), 'manual')
    return c.json({ ok: true }, 202)
  })

  // A subtask deleted for good (its row left the sheet; Basecamp has no trash
  // for subtasks) is created again from its snapshot under the same to-do. The
  // next run gives it a row in the sheet, like any record created in Basecamp.
  routes.post('/links/:id/deleted/:n/restore', async (c) => {
    if (!isAdmin(c)) return fail(c, 403, 'admin_only', ADMIN_ONLY)
    const linkId = c.req.param('id')
    const row = await c.env.DB.prepare(
      `SELECT d.rowid AS id, d.snapshot_json, d.restored_at FROM station_deleted d JOIN station_links l ON l.id = d.link_id
       WHERE d.rowid = ?1 AND d.link_id = ?2 AND l.unlinked_at IS NULL`,
    )
      .bind(Number(c.req.param('n')), linkId)
      .first<{ id: number; snapshot_json: string; restored_at: string | null }>()
    if (!row) return fail(c, 404, 'restore_not_found', 'لم يُعثر على هذه المهمة المحذوفة. حدّث الصفحة.')
    if (row.restored_at) return fail(c, 409, 'already_restored', 'أُعيد إنشاء هذه المهمة من قبل. ستجدها في الملف وفي Basecamp.')
    const snapshot = JSON.parse(row.snapshot_json) as RemoteSubtask
    const ctx = syncContext(c.env, deps())
    const created = await withServiceToken(ctx, async (token) => {
      const client = readClient(ctx)
      let parent
      try {
        parent = await client.todos.get(token, snapshot.todoId)
      } catch (error) {
        if (error instanceof NotFoundError) parent = null
        else throw error
      }
      if (!parent || parent.status !== 'active') return null
      const action = recreateSubtaskFromSnapshot(snapshot, { uid: `restore:${row.id}`, position: snapshot.position ?? 1 })
      if (action.type !== 'create_subtask') throw new Error('station: unexpected restore action')
      const sub = await client.subtasks.create(token, action.parentTodoId, action.create)
      if (snapshot.completed) await client.subtasks.complete(token, sub.id)
      return sub
    })
    if (!created) {
      return fail(c, 409, 'todo_not_in_basecamp', 'مهمتها الرئيسية لم تعد في Basecamp، فلا يمكن إعادتها تحتها. استرجع المهمة الرئيسية من سلة Basecamp أولاً، ثم أعد المحاولة.')
    }
    const at = new Date(deps().now()).toISOString()
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE station_deleted SET restored_at = ?2, restored_bc_id = ?3 WHERE rowid = ?1`).bind(row.id, at, created.id),
      c.env.DB.prepare(
        `INSERT INTO audit_log (at, actor_id, action, entity_type, entity_id, workbook_id, details_json) VALUES (?1, ?2, 'station.subtask.restore', 'station_link', ?3, NULL, ?4)`,
      ).bind(at, callerOf(c).id, linkId, JSON.stringify({ deletedBcId: snapshot.id, bcId: created.id })),
    ])
    await requestRun(c.env, linkId, 'manual')
    return c.json({ ok: true, bcId: created.id })
  })

  // A conflict (last edit won, §4.3): the losing value is written into the
  // sheet's cell; the next run sends it to Basecamp like any edit of the sheet.
  routes.post('/links/:id/conflicts/:n/restore', async (c) => {
    if (!isAdmin(c)) return fail(c, 403, 'admin_only', ADMIN_ONLY)
    const linkId = c.req.param('id')
    const entry = await c.env.DB.prepare(
      `SELECT g.id, g.task_uid, g.detail_json, l.spreadsheet_id FROM station_log g JOIN station_links l ON l.id = g.link_id
       WHERE g.id = ?1 AND g.link_id = ?2 AND g.action = 'conflict' AND l.unlinked_at IS NULL`,
    )
      .bind(Number(c.req.param('n')), linkId)
      .first<{ id: number; task_uid: string; detail_json: string; spreadsheet_id: string }>()
    if (!entry) return fail(c, 404, 'restore_not_found', 'لم يُعثر على هذا التعارض في السجل. حدّث الصفحة.')
    const detail = JSON.parse(entry.detail_json) as FieldConflict & { restoredAt?: string }
    if (detail.restoredAt) return fail(c, 409, 'already_restored', 'استُعيدت هذه القيمة من قبل.')
    if (detail.field !== 'title' && detail.field !== 'dueOn' && detail.field !== 'completed') {
      return fail(c, 409, 'not_restorable', 'هذا الحقل ليس له عمود في الملف، فلا تُستعاد قيمته من هنا. عدّله في Basecamp.')
    }
    const task = await c.env.DB.prepare(`SELECT level, google_sheet_id FROM station_tasks WHERE uid = ?1 AND link_id = ?2`)
      .bind(entry.task_uid, linkId)
      .first<{ level: 0 | 1; google_sheet_id: number }>()
    const tab = task
      ? await c.env.DB.prepare(`SELECT title FROM station_tabs WHERE link_id = ?1 AND google_sheet_id = ?2 AND unlinked_at IS NULL`)
          .bind(linkId, task.google_sheet_id)
          .first<{ title: string }>()
      : null
    const g = google(c)
    const place = task && tab ? (await g.rowIdentities(entry.spreadsheet_id)).find((r) => r.uid === entry.task_uid && r.sheetId === task.google_sheet_id) : undefined
    if (!task || !tab || !place) return fail(c, 409, 'row_not_found', 'لم يعد صف هذه المهمة في الملف، فلا مكان تُكتب فيه القيمة. أضفها في الملف يدوياً.')
    const header = ((await g.tabValues(entry.spreadsheet_id, [tab.title])).get(tab.title) ?? [])[0] ?? []
    const found = findColumns(header as CellValue[])
    if (!found.ok) return fail(c, 409, 'row_not_found', found.message)
    const loser = detail.winner === 'local' ? detail.remoteValue : detail.localValue
    const columns = found.columns
    const cell =
      detail.field === 'title'
        ? { column: task.level === 0 ? columns.main : columns.sub, value: textCell(String(loser ?? '')) }
        : detail.field === 'dueOn'
          ? { column: columns.due, value: typeof loser === 'string' ? loser : '' }
          : { column: columns.status, value: loser === true ? STATUS.done : STATUS.inProgress }
    await g.write(entry.spreadsheet_id, { cells: [{ tabTitle: tab.title, row: place.row, ...cell }] })
    const at = new Date(deps().now()).toISOString()
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE station_log SET detail_json = json_set(detail_json, '$.restoredAt', ?2) WHERE id = ?1`).bind(entry.id, at),
      c.env.DB.prepare(
        `INSERT INTO audit_log (at, actor_id, action, entity_type, entity_id, workbook_id, details_json) VALUES (?1, ?2, 'station.conflict.restore', 'station_link', ?3, NULL, ?4)`,
      ).bind(at, callerOf(c).id, linkId, JSON.stringify({ logId: entry.id, field: detail.field })),
    ])
    await requestRun(c.env, linkId, 'manual')
    return c.json({ ok: true })
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
    // The problem is solved now; the next run confirms it (and reopens it if the name is still unknown).
    await c.env.DB.prepare(`UPDATE station_alerts SET resolved_at = ?2 WHERE key = ?1 AND resolved_at IS NULL`).bind(`name_unmapped:${name}`, at).run()
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
