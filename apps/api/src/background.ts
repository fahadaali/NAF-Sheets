// Queue consumers and the cron trigger: dispatch only. The work lives in
// src/sync/outbound (bc-outbound) and src/sync/inbound (bc-inbound, cron).

import type { BcInboundMessage, BcOutboundMessage, Env } from './env'
import { handleInboundBatch, runReconciliation } from './sync/inbound'
import { handleOutboundBatch } from './sync/outbound'

export const OUTBOUND_QUEUE = 'bc-outbound'
export const INBOUND_QUEUE = 'bc-inbound'

export type QueueMessageBody = BcOutboundMessage | BcInboundMessage

/**
 * `bc-outbound` (§9.2) and `bc-inbound` (§9.3.4).
 *
 * TODO(sync-engine, phase 3): bc-outbound — rebuild the task's full state,
 * call `diff` from @naf-sheets/sync-engine and execute its OutboundActions
 * with the acting user's own token through @naf-sheets/basecamp; retry 429/5xx
 * (message.retry), never 404; after 5 attempts the message goes to the DLQ
 * and the row to sync_state 'error'.
 *
 * TODO(sync-engine, phase 4): bc-inbound — check recording.bucket.id against
 * bcProjectId, fetch the record with the service token, diff, apply through
 * the WorkbookRoom, log to sync_log.
 *
 * Until then every message is acknowledged without effect: no webhook is
 * registered before phase 3/4, and reconciliation (§9.4) rebuilds state from
 * Basecamp regardless of dropped events. Payloads are never logged (§14).
 */
// OPEN: bc-inbound and its retry count are this file's reading of spec §9.3.3 (OPEN_QUESTIONS.md #16).
export async function handleQueue(batch: MessageBatch<QueueMessageBody>, env: Env, ctx: ExecutionContext): Promise<void> {
  switch (batch.queue) {
    case OUTBOUND_QUEUE:
      return handleOutboundBatch(batch as MessageBatch<BcOutboundMessage>, env, ctx)
    case INBOUND_QUEUE:
      return handleInboundBatch(batch as MessageBatch<BcInboundMessage>, env, ctx)
    default:
      // A queue this Worker does not know: leave the messages to be retried.
      console.error(`queue consumer: unknown queue ${batch.queue}`)
      batch.retryAll()
  }
}

/**
 * Cron, every 15 minutes (§9.4).
 *
 * TODO(sync-engine, phase 4): reconciliation — for each linked list fetch
 * todos (and ?completed=true) with If-None-Match, follow Link rel="next",
 * diff changed tasks; check every webhook is `active` and re-enable it;
 * refresh bc_people_cache (§9.5). Read-only service token only.
 */
export async function handleScheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  await runReconciliation(env, ctx)
}
