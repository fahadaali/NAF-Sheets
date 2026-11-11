// `bc-outbound` consumer (spec §9.2.3–9): one message = one task to bring to
// Basecamp, with the acting person's own token (§3).
//
// A batch is grouped by workbook (docs/load-test.md, finding L2): each
// workbook's state (snapshot, sheets, plans, rows, names) is loaded once for
// the batch, and before each task only what may have changed since is read
// again (`refreshForTask`: the snapshot if a save moved it on, the sheets and
// mappings, the task's family rows). Everything per message is unchanged:
// its own task lease, its own actor's token, its own outcome (ack, retry with
// its own attempts, dead letter). A message for the same task and the same
// actor as one already sent earlier in the batch is acknowledged without a
// second step: the step sends the row's state as it is, which already holds
// that message's change.
//
// Retries are the queue's, never a sleep in the Worker (the client is built
// without in-process retries):
//   429                 → message.retry({ delaySeconds: Retry-After })
//   5xx, network, busy  → message.retry with exponential backoff
//   after 5 attempts    → dead-letter queue, row `error` + Arabic message
//   404, 403, 422 …     → never retried: row `error` + Arabic message
//   Account Inactive    → the whole account's sync stops; admin notice
// An actor without an active Basecamp link: row `error` asking to link the
// account. The service token is never used for a person's edit; its single
// documented use is §8.1's automatic re-assignment, logged «قاعدة تلقائية».

import {
  AccountInactiveError,
  BadRequestError,
  BasecampError,
  ForbiddenError,
  LimitReachedError,
  NetworkError,
  NotFoundError,
  RateLimitedError,
  ServerError,
  ValidationError,
} from '@naf-sheets/basecamp'
import { LinkFailure, withServiceToken, withUserToken } from '../../basecamp-link'
import { sendNotesImages } from '../../images/notes-images'
import type { LinkContext } from '../../basecamp-link'
import type { BcOutboundMessage, Env } from '../../env'
import { queueClient, syncContext } from '../deps'
import type { SyncDeps } from '../deps'
import { enqueueTasks } from '../detect'
import { AUTO_RULE_ACTOR, ROW_MESSAGES } from '../messages'
import type { RowMessageKey } from '../messages'
import { loadWorkbookState, refreshForTask } from '../state'
import type { WorkbookState } from '../state'
import {
  accountInactive,
  acquireLease,
  getWorkbookSync,
  isLinked,
  markAccountInactive,
  openDeletion,
  releaseLease,
  setRowAwaitingLink,
  setRowError,
  syncLogStatement,
  workbookIdOfTask,
} from '../store'
import type { WorkbookSyncRow } from '../store'
import { RecordUnreachable, syncTask } from '../task-sync'
import type { StepResult } from '../task-sync'
import { runDeletion, runUndo } from './deletion'

// OPEN: 5 attempts are the spec's; the backoff (10 s doubling, 300 s cap), the busy delay and the
// 2-minute task lease are this module's (S21).
/** Total deliveries of one message before it goes to the dead-letter queue (spec §9.2.8). */
export const MAX_ATTEMPTS = 5
/** First backoff; doubles per attempt (10, 20, 40, 80 s), capped. */
const BASE_BACKOFF_SECONDS = 10
const MAX_BACKOFF_SECONDS = 300
/** Another step holds the task's lease. */
const BUSY_DELAY_SECONDS = 5

export type Outcome = { kind: 'ack' } | { kind: 'retry'; delaySeconds: number; code: string }

export function backoffSeconds(attempts: number): number {
  return Math.min(MAX_BACKOFF_SECONDS, BASE_BACKOFF_SECONDS * 2 ** Math.max(0, attempts - 1))
}

const ACK: Outcome = { kind: 'ack' }

function isOutboundMessage(body: unknown): body is BcOutboundMessage {
  const b = body as Partial<BcOutboundMessage> | null
  return (
    typeof b === 'object' &&
    b !== null &&
    b.kind === 'task_changed' &&
    typeof b.workbookId === 'string' &&
    typeof b.taskUid === 'string' &&
    typeof b.actorUserId === 'string'
  )
}

/**
 * One workbook's share of a batch: its state is loaded on the first task that
 * needs it and kept for the next ones, which only refresh what may have
 * changed (`refreshForTask`). Dropped after an unexpected error, so the next
 * task starts from a fresh load.
 */
export class WorkbookBatch {
  private state: WorkbookState | null = null
  /** Full loads of the workbook (tests and the load test read it). */
  loads = 0

  constructor(
    private readonly env: Env,
    readonly workbookId: string,
  ) {}

  /** The state for `uid`'s step; null when the workbook or its snapshot cannot be read. */
  async stateFor(wb: WorkbookSyncRow, uid: string): Promise<WorkbookState | null> {
    if (this.state === null) {
      this.loads += 1
      this.state = await loadWorkbookState(this.env, wb)
      return this.state
    }
    Object.assign(this.state.wb, wb)
    if (!(await refreshForTask(this.env, this.state, uid))) {
      this.state = null
      return null
    }
    return this.state
  }

  /** After a step that threw: its in-memory changes may not all be in D1. */
  discard(): void {
    this.state = null
  }
}

/** Workbook batches of the last `handleOutboundBatchWith` call (for tests). */
export let lastBatchLoads: Array<{ workbookId: string; messages: number; loads: number }> = []

export async function handleOutboundBatchWith(batch: MessageBatch<BcOutboundMessage>, env: Env, deps: SyncDeps): Promise<void> {
  const groups = new Map<string, Array<Message<BcOutboundMessage>>>()
  for (const message of batch.messages) {
    if (!isOutboundMessage(message.body)) {
      message.ack()
      continue
    }
    const list = groups.get(message.body.workbookId) ?? []
    list.push(message)
    groups.set(message.body.workbookId, list)
  }
  lastBatchLoads = []
  /** After a 429: Basecamp's Retry-After, as a time; the rest of the batch is retried then, without a request. */
  let heldUntil = 0
  for (const [workbookId, messages] of groups) {
    const session = new WorkbookBatch(env, workbookId)
    /** `task + actor` already brought to Basecamp in this batch. */
    const sent = new Set<string>()
    for (const message of messages) {
      const key = `${message.body.taskUid}\u0000${message.body.actorUserId}`
      let outcome: Outcome
      const held = heldUntil - deps.now()
      if (sent.has(key)) {
        outcome = ACK
      } else if (held > 0 && message.attempts < MAX_ATTEMPTS) {
        // Honour Retry-After without waiting in the Worker: the queue delivers it again then.
        // (A message at its last attempt still gets that attempt.)
        outcome = { kind: 'retry', delaySeconds: Math.max(1, Math.ceil(held / 1000)), code: 'rate_limited' }
      } else {
        try {
          outcome = await processOutbound(env, deps, message.body, session)
        } catch (error) {
          session.discard()
          outcome = transient(error, message.attempts)
        }
        if (outcome.kind === 'ack') sent.add(key)
        if (outcome.kind === 'retry' && outcome.code === 'rate_limited') heldUntil = deps.now() + outcome.delaySeconds * 1000
      }
      await settle(env, deps, message, outcome)
    }
    lastBatchLoads.push({ workbookId, messages: messages.length, loads: session.loads })
  }
}

/** One message's own outcome: ack, retry with its own attempts, or the dead-letter queue (§9.2.8). */
async function settle(env: Env, deps: SyncDeps, message: Message<BcOutboundMessage>, outcome: Outcome): Promise<void> {
  if (outcome.kind === 'ack') {
    message.ack()
    return
  }
  if (message.attempts >= MAX_ATTEMPTS) {
    await deadLetter(env, deps, message, outcome.code)
    message.ack()
    return
  }
  message.retry({ delaySeconds: outcome.delaySeconds })
}

/** What to do with an error nobody handled: a retry later, with the server's delay when it gave one. */
export function transient(error: unknown, attempts: number): Outcome {
  if (error instanceof RateLimitedError) {
    const seconds = error.retryAfterMs !== null ? Math.max(1, Math.ceil(error.retryAfterMs / 1000)) : backoffSeconds(attempts)
    return { kind: 'retry', delaySeconds: seconds, code: 'rate_limited' }
  }
  if (error instanceof ServerError || error instanceof NetworkError) return { kind: 'retry', delaySeconds: backoffSeconds(attempts), code: error.code }
  if (error instanceof LinkFailure) return { kind: 'retry', delaySeconds: backoffSeconds(attempts), code: error.key }
  console.error(`sync: outbound step failed (${error instanceof Error ? error.name : 'unknown'})`)
  return { kind: 'retry', delaySeconds: backoffSeconds(attempts), code: 'internal' }
}

/** §9.2.8: the message goes to the dead-letter queue, the row to `error` with an Arabic message. */
async function deadLetter(env: Env, deps: SyncDeps, message: Message<BcOutboundMessage>, code: string): Promise<void> {
  const body = message.body
  const at = new Date(deps.now()).toISOString()
  const db = env.DB
  try {
    await env.BC_OUTBOUND_DLQ?.send(body)
  } catch (error) {
    console.error(`sync: dead-letter send failed (${error instanceof Error ? error.name : 'unknown'})`)
  }
  const workbookId = isOutboundMessage(body) ? body.workbookId : null
  const uid = isOutboundMessage(body) ? body.taskUid : null
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO sync_dead_letters (id, queue, workbook_id, task_uid, attempts, error_code, body_json, created_at)
         VALUES (?1, 'bc-outbound', ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (id) DO NOTHING`,
      )
      .bind(message.id, workbookId, uid, message.attempts, code, JSON.stringify(body ?? null), at),
  ]
  if (uid !== null && workbookId !== null && (await workbookIdOfTask(db, uid)) === workbookId) {
    statements.push(
      db.prepare(`UPDATE tasks SET sync_state = 'error', last_error = ?2, last_error_code = 'retries_exhausted' WHERE task_uid = ?1`).bind(uid, ROW_MESSAGES.retries_exhausted),
      syncLogStatement(db, { workbookId, taskUid: uid, direction: 'out', action: 'dead_letter', actor: 'system', status: 'error', error: code }, at),
    )
  }
  await db.batch(statements)
}

/**
 * OPEN: one message carries a task, not a field: when two people edit the same
 * row before it syncs, the full state goes out with the token of the message
 * being processed (S2).
 */
export async function processOutbound(env: Env, deps: SyncDeps, body: unknown, session?: WorkbookBatch): Promise<Outcome> {
  const outcome = await processOutboundStep(env, deps, body, session)
  // Pictures of the to-do's notes cell go out as files of its description,
  // after the step and outside its lease (src/images/notes-images.ts). Never
  // changes the message's outcome: a failure leaves the file `failed` with a retry.
  if (outcome.kind === 'ack' && isOutboundMessage(body)) {
    try {
      await sendNotesImages(env, deps, body.workbookId, body.taskUid, body.actorUserId)
    } catch (error) {
      console.warn(`sync: sending the notes pictures of a task failed (${error instanceof Error ? error.name : 'unknown'})`)
    }
  }
  return outcome
}

async function processOutboundStep(env: Env, deps: SyncDeps, body: unknown, session?: WorkbookBatch): Promise<Outcome> {
  if (!isOutboundMessage(body)) return ACK
  const batch = session ?? new WorkbookBatch(env, body.workbookId)
  const db = env.DB
  const uid = body.taskUid
  if ((await workbookIdOfTask(db, uid)) !== body.workbookId) return ACK
  const wb = await getWorkbookSync(db, body.workbookId)
  if (!wb || !isLinked(wb)) return ACK

  let ctx: LinkContext
  try {
    ctx = syncContext(env, deps)
  } catch (error) {
    if (!(error instanceof LinkFailure)) throw error
    await setRowError(db, uid, 'not_configured', ROW_MESSAGES.not_configured)
    return ACK
  }
  // Stopped account: nothing is sent; the row stays pending until an admin resumes the sync.
  if (await accountInactive(db, ctx.config.accountId)) return ACK

  const leaseId = crypto.randomUUID()
  if (!(await acquireLease(db, uid, leaseId, deps.now()))) return { kind: 'retry', delaySeconds: BUSY_DELAY_SECONDS, code: 'busy' }
  try {
    const state = await batch.stateFor(wb, uid)
    if (!state) return { kind: 'retry', delaySeconds: backoffSeconds(1), code: 'snapshot_unavailable' }
    try {
      return await withUserToken(ctx, body.actorUserId, (token) => forActor(env, deps, ctx, state, body, token))
    } catch (error) {
      if (error instanceof LinkFailure && (error.key === 'not_linked' || error.key === 'link_expired' || error.key === 'link_revoked')) {
        return await actorWithoutLink(env, deps, ctx, state, body, error.key)
      }
      return await refused(env, deps, ctx, uid, error)
    }
  } finally {
    await releaseLease(db, uid, leaseId)
  }
}

async function forActor(env: Env, deps: SyncDeps, ctx: LinkContext, state: WorkbookState, body: BcOutboundMessage, token: string): Promise<Outcome> {
  const db = env.DB
  const uid = body.taskUid
  const client = queueClient(ctx)
  const now = () => new Date(deps.now()).toISOString()
  const deletion = await openDeletion(db, uid)
  const deletionStep = { env, state, client, token, actor: body.actorUserId, uid, now }

  if (deletion?.state === 'requested') {
    const done = await runDeletion({ ...deletionStep, deletion })
    if (done === 'executed') {
      const row = state.taskRows.get(uid)
      if (row?.level === 1 && row.parent_uid !== null) await enqueueTasks(env, state.wb.id, [{ uid: row.parent_uid, actor: body.actorUserId }], deps.now, 0)
      return ACK
    }
    if (done !== 'present') return ACK
  }
  if (deletion?.state === 'undo_requested') {
    const undone = await runUndo({ ...deletionStep, deletion })
    if (undone !== 'undone') return ACK
  }
  if (deletion && (deletion.state === 'executed' || deletion.state === 'covered')) return ACK

  const result = await syncTask({
    env,
    state,
    uid,
    client,
    readToken: token,
    readAs: 'user',
    policy: { kind: 'write', token, actor: body.actorUserId },
    now,
  })
  await followUps(env, deps, state, uid, result, body.actorUserId)
  return result.status === 'contended' ? { kind: 'retry', delaySeconds: BUSY_DELAY_SECONDS, code: 'contended' } : ACK
}

/**
 * After a step: a subtask's change re-diffs its to-do (§8.1, engine contract
 * item 6); a created to-do lets its subtasks be created.
 */
async function followUps(env: Env, deps: SyncDeps, state: WorkbookState, uid: string, result: StepResult, actor: string): Promise<void> {
  if (result.status !== 'synced') return
  const next: Array<{ uid: string; actor: string }> = []
  if (result.level === 1 && result.parentUid !== null && (result.wroteBasecamp || result.assigneesChanged)) next.push({ uid: result.parentUid, actor })
  if (result.level === 0 && result.created) {
    for (const row of state.taskRows.values()) {
      if (row.parent_uid === uid && row.bc_recording_id === null && row.trashed_at === null) next.push({ uid: row.task_uid, actor: row.pending_actor_id ?? actor })
    }
  }
  if (next.length > 0) await enqueueTasks(env, state.wb.id, next, deps.now, 0)
}

/**
 * The actor has no usable Basecamp link. A person's edit is never sent with
 * another token: the row stays `pending` and asks them to link their account
 * (spec §3). The one exception
 * (§8.1) is a to-do in automatic mode whose only change is the union of its
 * subtasks' assignees: it goes with the service token, logged «قاعدة تلقائية».
 */
async function actorWithoutLink(
  env: Env,
  deps: SyncDeps,
  ctx: LinkContext,
  state: WorkbookState,
  body: BcOutboundMessage,
  key: 'not_linked' | 'link_expired' | 'link_revoked',
): Promise<Outcome> {
  const uid = body.taskUid
  const row = state.taskRows.get(uid)
  const deletion = await openDeletion(env.DB, uid)
  if (row && row.level === 0 && row.assign_mode === 'auto' && !deletion) {
    try {
      const result = await withServiceToken(ctx, (token) =>
        syncTask({
          env,
          state,
          uid,
          client: queueClient(ctx),
          readToken: token,
          readAs: 'service',
          policy: { kind: 'auto_only', writer: async () => ({ token, actor: AUTO_RULE_ACTOR }) },
          now: () => new Date(deps.now()).toISOString(),
        }),
      )
      if (result.status === 'synced' || result.status === 'held' || result.status === 'absent') return ACK
      if (result.status === 'contended') return { kind: 'retry', delaySeconds: BUSY_DELAY_SECONDS, code: 'contended' }
    } catch (error) {
      if (!(error instanceof LinkFailure)) return refused(env, deps, ctx, uid, error)
    }
  }
  // Spec §3 (S17, decided 2026-11-10): the row stays `pending` with the re-link message;
  // re-linking alone sends it (reconciliation, and GET …/sync, queue it again).
  const code = key === 'not_linked' ? 'actor_not_linked' : key === 'link_expired' ? 'actor_link_expired' : 'actor_link_revoked'
  await setRowAwaitingLink(env.DB, uid, code, ROW_MESSAGES[code])
  return ACK
}

/** Basecamp refused for good (never retried), or something transient to retry. */
async function refused(env: Env, deps: SyncDeps, ctx: LinkContext, uid: string, error: unknown): Promise<Outcome> {
  const db = env.DB
  if (error instanceof AccountInactiveError) {
    await markAccountInactive(db, ctx.config.accountId, new Date(deps.now()).toISOString())
    return ACK
  }
  const key = refusalKey(error)
  if (key === null) throw error
  await setRowError(db, uid, key, ROW_MESSAGES[key])
  return ACK
}

function refusalKey(error: unknown): RowMessageKey | null {
  if (error instanceof RecordUnreachable || error instanceof NotFoundError) return 'not_found'
  if (error instanceof ForbiddenError) return 'forbidden'
  if (error instanceof ValidationError || error instanceof BadRequestError) return 'validation_failed'
  if (error instanceof LimitReachedError) return 'limit_reached'
  if (error instanceof LinkFailure && error.key === 'not_configured') return 'not_configured'
  if (error instanceof BasecampError && !error.retryable) return 'unexpected_response'
  return null
}
