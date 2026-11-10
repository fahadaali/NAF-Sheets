// Phase 5: attachments (spec §10) and comments (§12.1 item 5) — the routes of
// packages/shared/src/api-phase5.ts. The sync step reads a to-do's files and
// comment counter (src/sync/task-sync.ts → ./attachments-sync.ts), and the
// webhook consumer handles `Comment` events (src/sync/inbound/consumer.ts).

import type { Hono } from 'hono'
import type { AppEnv } from '../auth'
import { defaultSyncDeps } from '../sync/deps'
import type { SyncDeps } from '../sync/deps'
import { attachmentSettingsRoutes, phase5WorkbookRoutes } from './routes'

export { syncAttachmentsFromTodo, writeAttachmentsCell } from './attachments-sync'
export { changeTodoDescription } from './description'
export { attachmentSettings } from './settings'

const REGISTERED = Symbol.for('naf-sheets.phase5.registered')

/**
 * Registered in src/index.ts after createApp, like the sync routes, so test
 * apps never reach real Basecamp; tests pass a fake `fetch`.
 */
export function registerPhase5Routes(app: Hono<AppEnv>, options: Partial<SyncDeps> = {}): void {
  const marked = app as unknown as Record<symbol, boolean>
  if (marked[REGISTERED]) throw new Error('phase 5 routes are already registered on this app')
  marked[REGISTERED] = true
  const deps: SyncDeps = { ...defaultSyncDeps(), ...options }
  app.route('/api/workbooks', phase5WorkbookRoutes(deps))
  const settings = attachmentSettingsRoutes()
  app.route('/api/attachment-settings', settings.read)
  app.route('/api/admin/attachment-settings', settings.admin)
}
