// Queue consumers and the cron trigger: dispatch only. The work lives in
// src/sync/outbound (bc-outbound) and src/sync/inbound (bc-inbound, cron).

import type { BcInboundQueueMessage, BcOutboundMessage, Env } from './env'
import { handleInboundBatch, runReconciliation } from './sync/inbound'
import { handleOutboundBatch } from './sync/outbound'
import { runBackup } from './phase7'

export const OUTBOUND_QUEUE = 'bc-outbound'
export const INBOUND_QUEUE = 'bc-inbound'

export type QueueMessageBody = BcOutboundMessage | BcInboundQueueMessage

/**
 * `bc-outbound` (§9.2): one task per message, written to Basecamp with the
 * acting user's own token; 429/5xx retried by the queue, never 404; after 5
 * attempts the dead-letter queue and a row error.
 * `bc-inbound` (§9.3.4): webhook deliveries (bucket checked, record always
 * fetched with the service token) and «مزامنة الآن» requests.
 * Payloads are never logged (§14).
 */
// OPEN: bc-inbound and its retry count are this file's reading of spec §9.3.3 (OPEN_QUESTIONS.md #16).
export async function handleQueue(batch: MessageBatch<QueueMessageBody>, env: Env, ctx: ExecutionContext): Promise<void> {
  switch (batch.queue) {
    case OUTBOUND_QUEUE:
      return handleOutboundBatch(batch as MessageBatch<BcOutboundMessage>, env, ctx)
    case INBOUND_QUEUE:
      return handleInboundBatch(batch as MessageBatch<BcInboundQueueMessage>, env, ctx)
    default:
      // A queue this Worker does not know: leave the messages to be retried.
      console.error(`queue consumer: unknown queue ${batch.queue}`)
      batch.retryAll()
  }
}

/**
 * Cron, every 15 minutes (§9.4): reconciliation of every linked list with
 * If-None-Match, webhook check, people caches. Read-only service token.
 */
export async function handleScheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  if (controller.cron === BACKUP_CRON) {
    await runBackup(env, new Date(controller.scheduledTime))
    return
  }
  await runReconciliation(env, ctx)
}

/**
 * The daily backup's cron (spec §14 «تصدير D1 يومي»), as in wrangler.toml:
 * 00:23 UTC = 03:23 in Riyadh. Every other cron is the reconciliation.
 */
export const BACKUP_CRON = '23 0 * * *'
