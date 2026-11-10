// NAF Sheets API Worker — entry point (spec §4).

import { createApp } from './app'
import { handleQueue, handleScheduled } from './background'
import type { QueueMessageBody } from './background'
import { registerBasecampLinkRoutes } from './basecamp-link'
import type { Env } from './env'
import { registerGoogleImportRoutes } from './google-import'

const app = createApp()
// Registered here, after createApp's auth guard, and not inside createApp:
// test apps built with createApp must not carry routes that reach real
// Launchpad/Google. Each module throws if registered twice on one app.
registerBasecampLinkRoutes(app)
registerGoogleImportRoutes(app)

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  queue: handleQueue,
  scheduled: handleScheduled,
} satisfies ExportedHandler<Env, QueueMessageBody>

export { WorkbookRoom } from './room'
