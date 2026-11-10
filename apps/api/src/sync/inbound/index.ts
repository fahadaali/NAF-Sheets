// Inbound sync (spec §9.3, §9.4, §9.5): Basecamp → platform.
// Receiving deliveries is src/routes/webhooks.ts (queued on bc-inbound).

import type { BcInboundQueueMessage, Env } from '../../env'
import { defaultSyncDeps } from '../deps'
import type { SyncDeps } from '../deps'
import { handleInboundBatchWith } from './consumer'
import { runReconciliationWith } from './reconcile'
import type { ReconcileReport } from './reconcile'

export { handleInboundBatchWith, processInbound } from './consumer'
export { reconcileWorkbook, requeueRelinked, requeueStalePending, runReconciliationWith, type ReconcileReport } from './reconcile'
export { ensureProjectWebhook, publicOrigin, webhookSecret, type WebhookStatus } from './webhooks'

/** `bc-inbound` consumer. */
export async function handleInboundBatch(batch: MessageBatch<BcInboundQueueMessage>, env: Env, _ctx: ExecutionContext): Promise<void> {
  await handleInboundBatchWith(batch, env, defaultSyncDeps())
}

/** The 15-minute cron (§9.4). */
export async function runReconciliation(env: Env, _ctx: ExecutionContext, deps: SyncDeps = defaultSyncDeps()): Promise<ReconcileReport> {
  return runReconciliationWith(env, deps)
}
