// The internal API of the NAF ecosystem (spec §13), read-only, protected by
// service tokens (./api-tokens.ts), never by a naf-id session:
//
//   GET /api/v1/workbooks                                       workbooks and their state
//   GET /api/v1/workbooks/:id/tasks?status=&assignee=&due_before=   tasks, unified shape
//   GET /api/v1/stats                                           done / overdue / by assignee
//
// Mounted in createApp *before* the naf-auth guard (like /health): a request
// here never reaches naf-auth, and every request must carry a live token.
//
// Tasks are the rows of synced sheets, read from the latest saved snapshot
// exactly as the sync engine reads them (sheet-model `readTasks`). Local
// sheets have no task identity (§2), so they have no tasks here.
//
// Not built: the optional outbound webhook («Webhook صادر اختياري لأحداث: مهمة
// أُنجزت، مهمة تأخرت») and any other system (§17-3 is open). OPEN (I2, I3).

import { Hono } from 'hono'
import type { Context } from 'hono'
import type { V1Assignee, V1StatsResponse, V1Task, V1TaskStatus, V1TasksResponse, V1WorkbooksResponse } from '@naf-sheets/shared'
import type { AppEnv } from '../auth'
import { listWorkbookRows, toSummary } from '../db'
import type { Env } from '../env'
import { ApiFailure, errorBody } from '../errors'
import { loadWorkbookState, readSheet, syncedSheets } from '../sync/state'
import { getWorkbookSync } from '../sync/store'
import { tokenFromRequest } from './api-tokens'

const STATUSES: ReadonlySet<string> = new Set<V1TaskStatus>(['done', 'open', 'overdue'])
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
/** OPEN (I4): "today" for `overdue` is judged in Riyadh time. */
export const STATS_TIME_ZONE = 'Asia/Riyadh'

/** YYYY-MM-DD of `at` in `timeZone` (UTC when the zone is unknown to the runtime). */
export function dayOf(at: Date, timeZone = STATS_TIME_ZONE): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at)
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
    return `${get('year')}-${get('month')}-${get('day')}`
  } catch {
    return at.toISOString().slice(0, 10)
  }
}

function isValidDate(text: string): boolean {
  if (!ISO_DATE.test(text)) return false
  const d = new Date(`${text}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text
}

export function statusOf(task: { completed: boolean; dueOn: string | null }, today: string): V1TaskStatus {
  if (task.completed) return 'done'
  if (task.dueOn !== null && task.dueOn < today) return 'overdue'
  return 'open'
}

/**
 * Every task of one workbook in the unified shape; null when the workbook
 * does not exist. Rows deleted, archived or trashed in Basecamp (shown struck
 * through, §9.3.10) are left out. OPEN (I5).
 */
export async function workbookTasks(env: Env, workbookId: string, today: string): Promise<V1Task[] | null> {
  const wb = await getWorkbookSync(env.DB, workbookId)
  if (!wb) return null
  const state = await loadWorkbookState(env, wb)
  if (!state) {
    console.error(`internal api: snapshot unreadable for workbook ${wb.id}`)
    throw new ApiFailure(500, 'snapshot_missing')
  }
  const names = state.directory.block
  const out: V1Task[] = []
  for (const sheet of syncedSheets(state)) {
    const read = readSheet(state, sheet)
    if (!read.ok) continue
    for (const task of read.value.tasks) {
      if (task.deletedRemotely) continue
      const assignees: V1Assignee[] = task.assignees.map((a) =>
        a.kind === 'external'
          ? { kind: 'external', id: a.externalContactId, name: names.externalContacts.get(a.externalContactId)?.name ?? null }
          : { kind: a.kind, id: String(a.bcPersonId), name: names.personNames.get(a.bcPersonId) ?? null },
      )
      out.push({
        uid: task.uid,
        workbookId: wb.id,
        sheetId: sheet.id,
        sheetTitle: sheet.title,
        parentUid: task.parentUid,
        level: task.level,
        title: task.title,
        status: statusOf(task, today),
        completed: task.completed,
        dueOn: task.dueOn,
        startsOn: task.startsOn,
        assignees,
        bcId: task.bcId,
        syncState: state.taskRows.get(task.uid)?.sync_state ?? null,
      })
    }
  }
  return out
}

function v1Error(c: Context<AppEnv>, error: ApiFailure): Response {
  const res = c.json(errorBody(error.key), error.status)
  if (error.status === 401) res.headers.set('www-authenticate', 'Bearer')
  return res
}

export function internalApiRoutes(options: { now?: () => Date } = {}): Hono<AppEnv> {
  const now = options.now ?? (() => new Date())
  const routes = new Hono<AppEnv>()

  routes.onError((error, c) => {
    if (error instanceof ApiFailure) return v1Error(c, error)
    console.error(`internal api: unhandled ${error.name} on ${c.req.method} ${new URL(c.req.url).pathname}`)
    return c.json(errorBody('internal'), 500)
  })

  routes.use('*', async (c, next) => {
    const token = await tokenFromRequest(c.env.DB, c.req.header('authorization'))
    if (!token) throw new ApiFailure(401, 'api_token_required')
    await next()
    c.res.headers.set('cache-control', 'no-store')
  })

  routes.get('/workbooks', async (c) => {
    const rows = await listWorkbookRows(c.env.DB, '', { all: true, q: null })
    const workbooks = rows.map((row) => {
      const { access: _access, ...rest } = toSummary(row, 'admin')
      return rest
    })
    return c.json<V1WorkbooksResponse>({ workbooks })
  })

  routes.get('/workbooks/:id/tasks', async (c) => {
    const status = c.req.query('status')
    const assignee = c.req.query('assignee')
    const dueBefore = c.req.query('due_before')
    if (status !== undefined && status !== '' && !STATUSES.has(status)) throw new ApiFailure(400, 'invalid_query')
    if (dueBefore !== undefined && dueBefore !== '' && !isValidDate(dueBefore)) throw new ApiFailure(400, 'invalid_query')
    const today = dayOf(now())
    const id = c.req.param('id')
    const tasks = id.length > 128 ? null : await workbookTasks(c.env, id, today)
    if (tasks === null) throw new ApiFailure(404, 'workbook_not_found')
    const filtered = tasks.filter(
      (t) =>
        (!status || t.status === status) &&
        (!assignee || t.assignees.some((a) => a.id === assignee)) &&
        (!dueBefore || (t.dueOn !== null && t.dueOn < dueBefore)),
    )
    return c.json<V1TasksResponse>({ workbookId: id, asOf: today, tasks: filtered })
  })

  routes.get('/stats', async (c) => {
    const today = dayOf(now())
    const rows = await listWorkbookRows(c.env.DB, '', { all: true, q: null })
    const totals = { tasks: 0, done: 0, open: 0, overdue: 0 }
    const byAssignee = new Map<string, V1StatsResponse['byAssignee'][number]>()
    // OPEN (I6): every snapshot is read on each call; fine at the platform's
    // size (docs/load-test.md), a cache if it grows.
    for (const row of rows) {
      const tasks = (await workbookTasks(c.env, row.id, today)) ?? []
      for (const t of tasks) {
        totals.tasks++
        totals[t.status]++
        for (const a of t.assignees) {
          const key = `${a.kind === 'external' ? 'external' : 'bc'}:${a.id}`
          const entry = byAssignee.get(key) ?? { ...a, kind: a.kind === 'follower' ? 'bc_person' : a.kind, tasks: 0, done: 0, open: 0, overdue: 0 }
          entry.tasks++
          entry[t.status]++
          byAssignee.set(key, entry)
        }
      }
    }
    const list = [...byAssignee.values()].sort((a, b) => b.tasks - a.tasks || a.id.localeCompare(b.id))
    return c.json<V1StatsResponse>({ asOf: today, workbooks: rows.length, totals, byAssignee: list })
  })

  routes.all('*', () => {
    throw new ApiFailure(404, 'route_not_found')
  })

  return routes
}
