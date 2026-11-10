// NAF Sheets API Worker — entry point (spec §4).

import { createApp } from './app'
import { handleQueue, handleScheduled } from './background'
import type { QueueMessageBody } from './background'
import type { Env } from './env'

const app = createApp()

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  queue: handleQueue,
  scheduled: handleScheduled,
} satisfies ExportedHandler<Env, QueueMessageBody>

export { WorkbookRoom } from './room'
