// Outbound sync (spec §7.3 linking wizard commit, §9.2): platform → Basecamp,
// and the sync routes of packages/shared/src/api-sync.ts.

import type { Hono } from 'hono'
import type { AppEnv } from '../../auth'
import type { BcOutboundMessage, Env } from '../../env'
import { defaultSyncDeps } from '../deps'
import type { SyncDeps } from '../deps'
import { externalContactRoutes, syncHealthRoutes, syncWorkbookRoutes } from '../routes'
import { handleOutboundBatchWith } from './consumer'

export { handleOutboundBatchWith, processOutbound, MAX_ATTEMPTS, backoffSeconds } from './consumer'
export { detectOutboundChanges, enqueueTasks, type DetectionInput, type DetectionResult } from '../detect'

export interface SyncRouteOptions extends Partial<SyncDeps> {}

const REGISTERED = Symbol.for('naf-sheets.sync.registered')

/**
 * Link wizard (POST /api/workbooks/:id/link/preview, /link) and the sync
 * routes. Registered in src/index.ts after createApp, like basecamp-link, so
 * test apps never reach real Basecamp; tests pass a fake `fetch`.
 */
export function registerSyncRoutes(app: Hono<AppEnv>, options: SyncRouteOptions = {}): void {
  const marked = app as unknown as Record<symbol, boolean>
  if (marked[REGISTERED]) throw new Error('sync routes are already registered on this app')
  marked[REGISTERED] = true
  const deps: SyncDeps = { ...defaultSyncDeps(), ...options }
  app.route('/api/workbooks', syncWorkbookRoutes(deps))
  app.route('/api/external-contacts', externalContactRoutes())
  app.route('/api/admin/sync-health', syncHealthRoutes())
}

/** `bc-outbound` consumer. */
export async function handleOutboundBatch(batch: MessageBatch<BcOutboundMessage>, env: Env, _ctx: ExecutionContext): Promise<void> {
  await handleOutboundBatchWith(batch, env, defaultSyncDeps())
}
