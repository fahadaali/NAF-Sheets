// NAF Sheets API Worker — the station (docs/station-plan.md): links between
// Google Sheets files and Basecamp projects.

import { createApp } from './app'
import { handleQueue, handleScheduled } from './background'
import type { QueueMessageBody } from './background'
import { registerBasecampLinkRoutes } from './basecamp-link'
import type { Env } from './env'
import { stationRoutes } from './station'

const app = createApp()
// Registered here, after createApp's auth guard, and not inside createApp:
// test apps built with createApp must not carry routes that reach real
// Launchpad/Google/Basecamp.
// The Basecamp sync account is connected through this flow (/auth/basecamp/start?service=1).
registerBasecampLinkRoutes(app)
app.route('/api/station', stationRoutes())

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  queue: (batch, env) => handleQueue(batch, env),
  scheduled: (controller, env) => handleScheduled(controller, env),
} satisfies ExportedHandler<Env, QueueMessageBody>

export { WorkbookRoom } from './legacy-room'
export { BasecampRateGate } from './basecamp-rate-gate'
