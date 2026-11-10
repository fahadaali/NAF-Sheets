// `bc-inbound` consumer (spec §9.3.2–5): Basecamp webhook deliveries, stored
// raw by POST /webhooks/basecamp/:secret, and «مزامنة الآن» requests.
//
// A delivery carries no signature and no description, completion or
// assignees, so nothing in it is trusted: `recording.bucket.id` must be the
// webhook's project (else ignored and logged), and the record is always
// fetched with the service token before anything is diffed. An unknown kind
// gets the same fetch and generic diff; it never fails the message.

import { AccountInactiveError, NotFoundError, UnexpectedResponseError } from '@naf-sheets/basecamp'
import type { RawWebhookEvent } from '@naf-sheets/basecamp'
import { LinkFailure, withServiceToken } from '../../basecamp-link'
import type { LinkContext } from '../../basecamp-link'
import type { BcInboundMessage, BcInboundQueueMessage, BcReconcileMessage, Env } from '../../env'
import { kvConditionalCache, readClient, syncContext } from '../deps'
import type { SyncDeps } from '../deps'
import { SYSTEM_ACTOR } from '../messages'
import { loadWorkbookState, syncedSheets } from '../state'
import { accountInactive, getWorkbookSync, isLinked, markAccountInactive, syncLogStatement, workbookByProject } from '../store'
import { MAX_ATTEMPTS, transient } from '../outbound/consumer'
import type { Outcome } from '../outbound/consumer'
import { inboundList, inboundSubtask, inboundTodo, reconcileList } from './records'
import { fetchSubtask, fetchTodo, TaskBusy } from './run'
import type { InboundRun } from './run'
import { reconcileWorkbook } from './reconcile'

const ACK: Outcome = { kind: 'ack' }

export async function handleInboundBatchWith(batch: MessageBatch<BcInboundQueueMessage>, env: Env, deps: SyncDeps): Promise<void> {
  for (const message of batch.messages) {
    let outcome: Outcome
    try {
      outcome = await processInbound(env, deps, message.body)
    } catch (error) {
      outcome = error instanceof TaskBusy ? { kind: 'retry', delaySeconds: 5, code: 'busy' } : transient(error, message.attempts)
    }
    if (outcome.kind === 'ack') {
      message.ack()
      continue
    }
    if (message.attempts >= MAX_ATTEMPTS) {
      // OPEN: given up after 5 attempts; recorded, not sent to a DLQ: reconciliation reads the same records within 15 minutes (S22).
      await env.DB.prepare(
        `INSERT INTO sync_dead_letters (id, queue, workbook_id, task_uid, attempts, error_code, body_json, created_at)
         VALUES (?1, 'bc-inbound', ?2, NULL, ?3, ?4, ?5, ?6) ON CONFLICT (id) DO NOTHING`,
      )
        .bind(message.id, message.body?.kind === 'reconcile' ? message.body.workbookId : null, message.attempts, outcome.code, JSON.stringify({ kind: message.body?.kind ?? null }), new Date(deps.now()).toISOString())
        .run()
      message.ack()
      continue
    }
    message.retry({ delaySeconds: outcome.delaySeconds })
  }
}

export async function processInbound(env: Env, deps: SyncDeps, body: BcInboundQueueMessage): Promise<Outcome> {
  if (body?.kind === 'reconcile') return reconcileNow(env, deps, body)
  if (body?.kind === 'basecamp_webhook') return webhookDelivery(env, deps, body)
  return ACK
}

async function reconcileNow(env: Env, deps: SyncDeps, body: BcReconcileMessage): Promise<Outcome> {
  const wb = await getWorkbookSync(env.DB, body.workbookId)
  if (!wb || !isLinked(wb)) return ACK
  let ctx: LinkContext
  try {
    ctx = syncContext(env, deps)
  } catch (error) {
    if (error instanceof LinkFailure) return ACK
    throw error
  }
  if (await accountInactive(env.DB, ctx.config.accountId)) return ACK
  try {
    await reconcileWorkbook(env, deps, ctx, wb, { force: true })
  } catch (error) {
    if (error instanceof AccountInactiveError) {
      await markAccountInactive(env.DB, ctx.config.accountId, new Date(deps.now()).toISOString())
      return ACK
    }
    throw error
  }
  return ACK
}

function parseEvent(text: string): RawWebhookEvent | null {
  try {
    const value = JSON.parse(text) as unknown
    if (typeof value !== 'object' || value === null) return null
    const event = value as Partial<RawWebhookEvent>
    if (typeof event.kind !== 'string' || typeof event.recording !== 'object' || event.recording === null) return null
    return event as RawWebhookEvent
  } catch {
    return null
  }
}

async function webhookDelivery(env: Env, deps: SyncDeps, body: BcInboundMessage): Promise<Outcome> {
  const db = env.DB
  const at = new Date(deps.now()).toISOString()
  const hook = await db.prepare(`SELECT bc_project_id FROM bc_webhooks WHERE bc_webhook_id = ?1`).bind(body.bcWebhookId).first<{ bc_project_id: number }>()
  if (!hook || hook.bc_project_id !== body.bcProjectId) return ACK
  const wb = await workbookByProject(db, body.bcProjectId)
  if (!wb || !isLinked(wb)) return ACK
  // Payloads are never logged (§14): only what was decided.
  const log = (action: string, status: 'ignored' | 'error', error: string) =>
    syncLogStatement(db, { workbookId: wb.id, taskUid: null, direction: 'in', action, actor: SYSTEM_ACTOR, status, error }, at).run()

  const event = parseEvent(body.body)
  if (!event) {
    await log('webhook', 'ignored', 'invalid_payload')
    return ACK
  }
  const bucketId = (event.recording.bucket as { id?: unknown } | undefined)?.id
  if (bucketId !== body.bcProjectId) {
    await log('webhook', 'ignored', 'bucket_mismatch')
    return ACK
  }
  const recordingId = event.recording.id
  if (typeof recordingId !== 'number' || !Number.isSafeInteger(recordingId) || recordingId <= 0) {
    await log('webhook', 'ignored', 'invalid_recording')
    return ACK
  }

  let ctx: LinkContext
  try {
    ctx = syncContext(env, deps)
  } catch (error) {
    if (error instanceof LinkFailure) return ACK
    throw error
  }
  if (await accountInactive(db, ctx.config.accountId)) return ACK
  try {
    await withServiceToken(ctx, async (token) => {
      const state = await loadWorkbookState(env, wb)
      if (!state) throw new TaskBusy('snapshot unavailable')
      const run: InboundRun = {
        env,
        deps,
        ctx,
        token,
        client: readClient(ctx, kvConditionalCache(env.SETTINGS)),
        state,
        now: () => new Date(deps.now()).toISOString(),
        namesRefreshed: false,
      }
      await handleEvent(run, event, recordingId)
    })
  } catch (error) {
    if (error instanceof AccountInactiveError) {
      await markAccountInactive(db, ctx.config.accountId, at)
      return ACK
    }
    if (error instanceof LinkFailure && error.key !== 'basecamp_unavailable') {
      // No usable service token: reconciliation catches up once it is linked.
      await log('webhook', 'ignored', error.key)
      return ACK
    }
    throw error
  }
  return ACK
}

/** §9.3.5, by recording type; the kind only decides the few list-level cases. */
async function handleEvent(run: InboundRun, event: RawWebhookEvent, recordingId: number): Promise<void> {
  const kind = event.kind
  const type = event.recording.type
  const creatorBcId = typeof event.creator?.id === 'number' ? event.creator.id : null

  // *_copied / *_inserted: a full refresh of the lists concerned.
  if (/_(copied|inserted)$/.test(kind)) {
    for (const sheet of syncedSheets(run.state)) await reconcileList(run, sheet, { force: true })
    return
  }
  switch (type) {
    case 'Todo': {
      try {
        await inboundTodo(run, { id: recordingId, remote: await fetchTodo(run, recordingId), creatorBcId })
      } catch (error) {
        // A loose to-do (no list) or another shape the sheet cannot hold.
        if (!(error instanceof UnexpectedResponseError)) throw error
        await ignore(run, kind, 'unexpected_record')
      }
      return
    }
    case 'Kanban::Step': {
      try {
        await inboundSubtask(run, recordingId, await fetchSubtask(run, recordingId), creatorBcId)
      } catch (error) {
        // A card's step shares the wire type; only a to-do's steps belong to a sheet.
        if (!(error instanceof UnexpectedResponseError)) throw error
        await ignore(run, kind, 'not_a_todo_step')
      }
      return
    }
    case 'Todolist':
      await inboundList(run, recordingId, kind)
      return
    case 'Comment':
      // Phase 5 (§9.3.5 `comment_created`, and any other comment kind): the
      // comment is read, never trusted from the payload; its to-do is read
      // again, which refreshes the row's comment counter (and anything else).
      await commentEvent(run, kind, recordingId, creatorBcId)
      return
    case 'Upload':
      // OPEN (P8): the documented API ties an upload (docs & files) to a vault, not to a to-do (§10 "uploads tied to the task").
      await ignore(run, kind, 'upload_not_linked_to_task')
      return
    default:
      await ignore(run, kind, 'unknown_type')
  }
}

async function commentEvent(run: InboundRun, kind: string, commentId: number, creatorBcId: number | null): Promise<void> {
  let parent: { id: number; type: string } | null = null
  try {
    const comment = await run.client.comments.get(run.token, commentId)
    if (comment.bucket?.id !== run.state.wb.bc_project_id) return ignore(run, kind, 'bucket_mismatch')
    parent = comment.parent ? { id: comment.parent.id, type: comment.parent.type } : null
  } catch (error) {
    if (error instanceof NotFoundError) return ignore(run, kind, 'comment_gone')
    if (error instanceof UnexpectedResponseError) return ignore(run, kind, 'unexpected_record')
    throw error
  }
  // Comments live on to-dos only (§8 table); a comment on anything else is not a row's.
  if (!parent || parent.type !== 'Todo' || !Number.isSafeInteger(parent.id) || parent.id <= 0) return ignore(run, kind, 'comment_not_on_todo')
  try {
    await inboundTodo(run, { id: parent.id, remote: await fetchTodo(run, parent.id), creatorBcId })
  } catch (error) {
    if (!(error instanceof UnexpectedResponseError)) throw error
    await ignore(run, kind, 'unexpected_record')
  }
}

async function ignore(run: InboundRun, kind: string, reason: string): Promise<void> {
  await syncLogStatement(run.env.DB, { workbookId: run.state.wb.id, taskUid: null, direction: 'in', action: `webhook:${kind}`.slice(0, 100), actor: SYSTEM_ACTOR, status: 'ignored', error: reason }, run.now()).run()
}
