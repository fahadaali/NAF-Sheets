// Reconciliation (spec §9.4): every 15 minutes, and on «مزامنة الآن».
// Read-only in Basecamp with the service token, except re-enabling or
// recreating the project's webhook. Refreshes bc_people_cache and
// bc_account_people_cache, and queues again the rows whose outbound message
// may have been lost (still `pending` after 10 minutes).

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
  stopped: 'not_configured' | 'account_inactive' | null
}

export async function runReconciliationWith(env: Env, deps: SyncDeps): Promise<ReconcileReport> {
  const report: ReconcileReport = { workbooks: 0, lists: 0, notModified: 0, requeued: 0, stopped: null }
  let ctx: LinkContext
  try {
    ctx = syncContext(env, deps)
  } catch (error) {
    if (error instanceof LinkFailure) return { ...report, stopped: 'not_configured' }
    throw error
  }
  if (await accountInactive(env.DB, ctx.config.accountId)) return { ...report, stopped: 'account_inactive' }
  try {
    await refreshAccountPeople(ctx)
  } catch (error) {
    if (error instanceof AccountInactiveError) {
      await markAccountInactive(env.DB, ctx.config.accountId, new Date(deps.now()).toISOString())
      return { ...report, stopped: 'account_inactive' }
    }
    console.warn(`sync: account people refresh failed (${error instanceof Error ? error.name : 'unknown'})`)
  }
  for (const wb of await linkedWorkbooks(env.DB)) {
    try {
      const one = await reconcileWorkbook(env, deps, ctx, wb, { force: false })
      report.workbooks += 1
      report.lists += one.lists
      report.notModified += one.notModified
      report.requeued += one.requeued
    } catch (error) {
      if (error instanceof AccountInactiveError) {
        await markAccountInactive(env.DB, ctx.config.accountId, new Date(deps.now()).toISOString())
        return { ...report, stopped: 'account_inactive' }
      }
      // One workbook's failure never stops the others.
      console.error(`sync: reconciliation of workbook ${wb.id} failed (${error instanceof Error ? error.name : 'unknown'})`)
    }
  }
  return report
}

export async function reconcileWorkbook(
  env: Env,
  deps: SyncDeps,
  ctx: LinkContext,
  wb: WorkbookSyncRow,
  options: { force: boolean },
): Promise<{ lists: number; notModified: number; requeued: number; webhook: WebhookStatus | null }> {
  const out = { lists: 0, notModified: 0, requeued: 0, webhook: null as WebhookStatus | null }
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
      const run: InboundRun = { env, deps, ctx, token, client, state, now: () => new Date(deps.now()).toISOString(), namesRefreshed: true }
      for (const sheet of syncedSheets(state)) {
        try {
          const result = await reconcileList(run, sheet, options)
          out.lists += 1
          if (result === 'not_modified') out.notModified += 1
        } catch (error) {
          if (error instanceof TaskBusy) continue
          throw error
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

