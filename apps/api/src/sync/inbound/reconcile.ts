// Reconciliation (spec §9.4): every 15 minutes, and on «مزامنة الآن».
// Read-only in Basecamp with the service token, except re-enabling or
// recreating the project's webhook. Refreshes bc_people_cache and
// bc_account_people_cache, and queues again the rows whose outbound message
// may have been lost (still `pending` after 10 minutes).
//
// The cron run (docs/load-test.md, finding L3) holds a lease (`sync_jobs`
// row `reconciliation`), so two runs never overlap, and has a time budget
// (12 minutes, under the 15-minute interval): it stops between two lists when
// the budget is spent and stores where it stopped; the next run continues
// from there to the end, then starts over from the first workbook.

import { AccountInactiveError } from '@naf-sheets/basecamp'
import { LinkFailure, refreshAccountPeople, withServiceToken } from '../../basecamp-link'
import type { LinkContext } from '../../basecamp-link'
import { storeProjectPeople } from '../../basecamp-link/people'
import type { Env } from '../../env'
import { kvConditionalCache, readClient, syncContext } from '../deps'
import type { SyncDeps } from '../deps'
import { enqueueTasks } from '../detect'
import { loadWorkbookState, syncedSheets } from '../state'
import { ACTOR_LINK_CODES, accountInactive, linkedWorkbooks, markAccountInactive } from '../store'
import type { WorkbookSyncRow } from '../store'
import { reconcileList } from './records'
import { TaskBusy } from './run'
import type { InboundRun } from './run'
import { ensureProjectWebhook } from './webhooks'
import type { WebhookStatus } from './webhooks'

/** A pending row older than this is queued again (its message may have been lost). */
export const STALE_PENDING_MS = 10 * 60_000

export interface ReconcileReport {
  workbooks: number
  lists: number
  notModified: number
  requeued: number
  /** To-dos read one by one because the list showed them changed. */
  todosRead: number
  /** To-dos whose list entry moved `updated_at` but held nothing new (no read; see `reconcileList`). */
  todosConfirmedFromList: number
  /** Stopped at the time budget; the next run continues where this one stopped. */
  continued: boolean
  /** Where this run started, when it continued an earlier one. */
  resumedFrom: { workbookId: string; sheetId: string | null } | null
  stopped: 'not_configured' | 'account_inactive' | 'already_running' | null
}

export const RECONCILE_JOB = 'reconciliation'
/** Under the 15-minute cron interval, with room for the run's last list and its bookkeeping. */
export const RECONCILE_BUDGET_MS = 12 * 60_000
/** The lease outlives the budget by this much: a list that runs past the budget is still covered. */
const LEASE_MARGIN_MS = 3 * 60_000

export interface ReconcileOptions {
  /** Default 12 minutes. */
  budgetMs?: number
  /** The clock the budget is measured on (default `deps.now`; the load test passes the rate limiter's clock). */
  clock?: () => number
}

/** Shared by the lists of one run: when to stop, and how much was read. */
export interface RunBudget {
  deadline: number
  clock: () => number
  listsDone: number
  todosRead: number
  todosConfirmedFromList: number
}

type Cursor = { workbookId: string; sheetId: string | null }

async function acquireJob(db: D1Database, leaseId: string, nowMs: number, untilMs: number): Promise<{ acquired: false } | { acquired: true; cursor: Cursor | null }> {
  const now = new Date(nowMs).toISOString()
  await db.prepare(`INSERT INTO sync_jobs (name, updated_at) VALUES (?1, ?2) ON CONFLICT (name) DO NOTHING`).bind(RECONCILE_JOB, now).run()
  const taken = await db
    .prepare(
      `UPDATE sync_jobs SET lease_id = ?2, lease_until = ?3, started_at = ?4, updated_at = ?4
       WHERE name = ?1 AND (lease_id IS NULL OR lease_until IS NULL OR lease_until < ?4)`,
    )
    .bind(RECONCILE_JOB, leaseId, new Date(untilMs).toISOString(), now)
    .run()
  if (taken.meta.changes !== 1) return { acquired: false }
  const row = await db.prepare(`SELECT cursor_json FROM sync_jobs WHERE name = ?1`).bind(RECONCILE_JOB).first<{ cursor_json: string | null }>()
  let cursor: Cursor | null = null
  try {
    const parsed = row?.cursor_json ? (JSON.parse(row.cursor_json) as Partial<Cursor>) : null
    if (parsed && typeof parsed.workbookId === 'string') cursor = { workbookId: parsed.workbookId, sheetId: typeof parsed.sheetId === 'string' ? parsed.sheetId : null }
  } catch {
    // An unreadable cursor: start from the first workbook.
  }
  return { acquired: true, cursor }
}

async function releaseJob(db: D1Database, leaseId: string, cursor: Cursor | null, nowMs: number): Promise<void> {
  const now = new Date(nowMs).toISOString()
  await db
    .prepare(`UPDATE sync_jobs SET lease_id = NULL, lease_until = NULL, cursor_json = ?3, finished_at = ?4, updated_at = ?4 WHERE name = ?1 AND lease_id = ?2`)
    .bind(RECONCILE_JOB, leaseId, cursor ? JSON.stringify(cursor) : null, now)
    .run()
}

export async function runReconciliationWith(env: Env, deps: SyncDeps, options: ReconcileOptions = {}): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    workbooks: 0,
    lists: 0,
    notModified: 0,
    requeued: 0,
    todosRead: 0,
    todosConfirmedFromList: 0,
    continued: false,
    resumedFrom: null,
    stopped: null,
  }
  let ctx: LinkContext
  try {
    ctx = syncContext(env, deps)
  } catch (error) {
    if (error instanceof LinkFailure) return { ...report, stopped: 'not_configured' }
    throw error
  }
  if (await accountInactive(env.DB, ctx.config.accountId)) return { ...report, stopped: 'account_inactive' }

  const clock = options.clock ?? deps.now
  const budgetMs = options.budgetMs ?? RECONCILE_BUDGET_MS
  const started = clock()
  const leaseId = crypto.randomUUID()
  // The lease is kept on the real clock (deps.now), like every other lease.
  const acquired = await acquireJob(env.DB, leaseId, deps.now(), deps.now() + budgetMs + LEASE_MARGIN_MS)
  if (!acquired.acquired) {
    console.warn('sync: reconciliation skipped, the previous run still holds the lease')
    return { ...report, stopped: 'already_running' }
  }
  const resume = acquired.cursor
  report.resumedFrom = resume
  let cursor: Cursor | null = null
  const budget: RunBudget = { deadline: started + budgetMs, clock, listsDone: 0, todosRead: 0, todosConfirmedFromList: 0 }
  try {
    try {
      await refreshAccountPeople(ctx)
    } catch (error) {
      if (error instanceof AccountInactiveError) {
        await markAccountInactive(env.DB, ctx.config.accountId, new Date(deps.now()).toISOString())
        return { ...report, stopped: 'account_inactive' }
      }
      console.warn(`sync: account people refresh failed (${error instanceof Error ? error.name : 'unknown'})`)
    }
    let workbooks = await linkedWorkbooks(env.DB)
    // Continue where the last run stopped (workbooks are ordered by id).
    if (resume) workbooks = workbooks.filter((wb) => wb.id >= resume.workbookId)
    for (const wb of workbooks) {
      // Always some progress: the budget is checked once at least one list was done.
      if (budget.listsDone > 0 && budget.clock() >= budget.deadline) {
        cursor = { workbookId: wb.id, sheetId: null }
        break
      }
      try {
        const fromSheetId = resume && resume.workbookId === wb.id ? resume.sheetId : null
        const one = await reconcileWorkbook(env, deps, ctx, wb, { force: false, budget, fromSheetId })
        report.workbooks += 1
        report.lists += one.lists
        report.notModified += one.notModified
        report.requeued += one.requeued
        if (one.stoppedAtSheetId !== null) {
          cursor = { workbookId: wb.id, sheetId: one.stoppedAtSheetId }
          break
        }
      } catch (error) {
        if (error instanceof AccountInactiveError) {
          await markAccountInactive(env.DB, ctx.config.accountId, new Date(deps.now()).toISOString())
          return { ...report, stopped: 'account_inactive' }
        }
        // One workbook's failure never stops the others.
        console.error(`sync: reconciliation of workbook ${wb.id} failed (${error instanceof Error ? error.name : 'unknown'})`)
      }
    }
    report.continued = cursor !== null
    return report
  } finally {
    report.todosRead = budget.todosRead
    report.todosConfirmedFromList = budget.todosConfirmedFromList
    await releaseJob(env.DB, leaseId, cursor, deps.now())
  }
}

export async function reconcileWorkbook(
  env: Env,
  deps: SyncDeps,
  ctx: LinkContext,
  wb: WorkbookSyncRow,
  options: { force: boolean; budget?: RunBudget; fromSheetId?: string | null },
): Promise<{ lists: number; notModified: number; requeued: number; webhook: WebhookStatus | null; stoppedAtSheetId: string | null }> {
  const out = { lists: 0, notModified: 0, requeued: 0, webhook: null as WebhookStatus | null, stoppedAtSheetId: null as string | null }
  const projectId = wb.bc_project_id
  if (projectId === null) return out
  out.webhook = await ensureProjectWebhook(env, { workbookId: wb.id, bcProjectId: projectId }, deps, ctx)
  try {
    await withServiceToken(ctx, async (token) => {
      const client = readClient(ctx, kvConditionalCache(env.SETTINGS))
      const at = new Date(deps.now()).toISOString()
      try {
        await storeProjectPeople(env.DB, projectId, await client.people.listProject(token, projectId).all(), at)
      } catch (error) {
        if (error instanceof AccountInactiveError) throw error
        console.warn(`sync: project people refresh failed (${error instanceof Error ? error.name : 'unknown'})`)
      }
      const state = await loadWorkbookState(env, wb)
      if (!state) return
      const run: InboundRun = { env, deps, ctx, token, client, state, now: () => new Date(deps.now()).toISOString(), namesRefreshed: true, budget: options.budget }
      let sheets = syncedSheets(state)
      // Continuing an earlier run: from the list it stopped before (all of them if that list is gone).
      const from = options.fromSheetId ? sheets.findIndex((s) => s.id === options.fromSheetId) : -1
      if (from > 0) sheets = sheets.slice(from)
      for (const sheet of sheets) {
        const budget = options.budget
        if (budget && budget.listsDone > 0 && budget.clock() >= budget.deadline) {
          out.stoppedAtSheetId = sheet.id
          break
        }
        try {
          const result = await reconcileList(run, sheet, { force: options.force })
          out.lists += 1
          if (result === 'not_modified') out.notModified += 1
        } catch (error) {
          if (error instanceof TaskBusy) continue
          throw error
        } finally {
          if (budget) budget.listsDone += 1
        }
      }
    })
  } catch (error) {
    if (!(error instanceof LinkFailure)) throw error
    // No service token: nothing can be read; the workbook's notice says so.
  }
  out.requeued = await requeueStalePending(env, deps, wb.id)
  return out
}

const LINK_CODES_SQL = ACTOR_LINK_CODES.map((c) => `'${c}'`).join(', ')

/**
 * Pending rows queued again, each with its own author (§3):
 * - a row whose message may have been lost (still pending after 10 minutes);
 * - a row held for its author's Basecamp link (S17), as soon as that link is
 *   active again — whatever its age. A row whose author is still not linked
 *   is left alone, so nothing churns.
 */
export async function requeueStalePending(env: Env, deps: SyncDeps, workbookId: string, olderThanMs = STALE_PENDING_MS): Promise<number> {
  const cutoff = new Date(deps.now() - olderThanMs).toISOString()
  const { results } = await env.DB.prepare(
    `SELECT t.task_uid, t.pending_actor_id FROM tasks t JOIN sheets s ON s.id = t.sheet_id
     WHERE s.workbook_id = ?1 AND t.sync_state = 'pending' AND t.pending_actor_id IS NOT NULL
       AND (t.sync_lease_until IS NULL OR t.sync_lease_until < ?3)
       AND IFNULL(t.last_error_code, '') NOT IN (${LINK_CODES_SQL})
       AND (t.last_local_change_at IS NULL OR t.last_local_change_at < ?2)`,
  )
    .bind(workbookId, cutoff, new Date(deps.now()).toISOString())
    .all<{ task_uid: string; pending_actor_id: string }>()
  const stale = results.length === 0 ? 0 : await enqueueTasks(env, workbookId, results.map((r) => ({ uid: r.task_uid, actor: r.pending_actor_id })), deps.now, 0)
  return stale + (await requeueRelinked(env, deps, workbookId))
}

/**
 * Rows held for their author's Basecamp link (spec §3, S17) whose author has
 * an active link again: queued with that author's identity, and the re-link
 * message cleared (the row stays `pending` until it is sent). Called by
 * reconciliation and by GET …/sync, so linking again is enough.
 */
export async function requeueRelinked(env: Env, deps: SyncDeps, workbookId: string): Promise<number> {
  const db = env.DB
  const { results } = await db
    .prepare(
      `SELECT t.task_uid, t.pending_actor_id FROM tasks t
       JOIN sheets s ON s.id = t.sheet_id
       JOIN user_basecamp_links l ON l.user_id = t.pending_actor_id AND l.status = 'active' AND l.encrypted_tokens <> ''
       WHERE s.workbook_id = ?1 AND t.sync_state = 'pending' AND t.last_error_code IN (${LINK_CODES_SQL})
         AND (t.sync_lease_until IS NULL OR t.sync_lease_until < ?2)`,
    )
    .bind(workbookId, new Date(deps.now()).toISOString())
    .all<{ task_uid: string; pending_actor_id: string }>()
  if (results.length === 0) return 0
  await db.batch(
    results.map((r) =>
      db
        .prepare(`UPDATE tasks SET last_error = NULL, last_error_code = NULL WHERE task_uid = ?1 AND sync_state = 'pending' AND last_error_code IN (${LINK_CODES_SQL})`)
        .bind(r.task_uid),
    ),
  )
  return enqueueTasks(env, workbookId, results.map((r) => ({ uid: r.task_uid, actor: r.pending_actor_id })), deps.now, 0)
}

