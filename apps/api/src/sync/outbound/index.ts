// Outbound sync (spec §7.3 linking wizard commit, §9.2): platform → Basecamp.
// Wave 3 stub — the outbound work replaces every body below.

import type { Hono } from 'hono'
import type { AppEnv } from '../../auth'
import type { BcOutboundMessage, Env } from '../../env'

/**
 * Link wizard (POST /api/workbooks/:id/link/preview, /link) and the sync
 * routes of packages/shared/src/api-sync.ts. Registered in src/index.ts after
 * createApp, like basecamp-link, so test apps never reach real Basecamp.
 */
export function registerSyncRoutes(_app: Hono<AppEnv>): void {}

/** `bc-outbound` consumer. Until implemented: acknowledged without effect. */
export async function handleOutboundBatch(batch: MessageBatch<BcOutboundMessage>, _env: Env, _ctx: ExecutionContext): Promise<void> {
  for (const message of batch.messages) message.ack()
}
