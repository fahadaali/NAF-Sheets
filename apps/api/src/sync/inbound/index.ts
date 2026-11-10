// Inbound sync (spec §9.3, §9.4, §9.5): Basecamp → platform.
// Wave 3 stub — the inbound work replaces every body below.
// Receiving deliveries already exists: src/routes/webhooks.ts enqueues them.

import type { BcInboundMessage, Env } from '../../env'

/** `bc-inbound` consumer. Until implemented: acknowledged without effect. */
export async function handleInboundBatch(batch: MessageBatch<BcInboundMessage>, _env: Env, _ctx: ExecutionContext): Promise<void> {
  for (const message of batch.messages) message.ack()
}

/** The 15-minute cron (§9.4). Until implemented: no-op. */
export async function runReconciliation(_env: Env, _ctx: ExecutionContext): Promise<void> {}

/**
 * Creates (or re-enables) the project's webhook with the service token
 * (§9.3.1). Called by the link wizard's commit once a workbook is linked.
 * Until implemented: does nothing and reports `skipped`.
 */
export async function ensureProjectWebhook(
  _env: Env,
  _input: { workbookId: string; bcProjectId: number },
): Promise<{ status: 'active' | 'skipped' }> {
  return { status: 'skipped' }
}
