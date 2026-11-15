// The station (docs/station-plan.md): links between Google Sheets and Basecamp.

import type { BcInboundQueueMessage, Env } from '../env'
import { defaultSyncDeps } from './deps'
import { requestRun, runStation, type StationDeps } from './runner'

export { stationRoutes, stationWebhookRoutes } from './routes'
export { runStation, stationMinute, sendDueAlerts, requestRun } from './runner'
export { syncLink } from './run'

/**
 * `bc-inbound` messages for the station: its own runs, and Basecamp webhook
 * deliveries of projects the station links (each becomes a run of every link
 * on that project; the run reads Basecamp itself, so the delivery body is not
 * trusted for anything). Returns the batch's other messages for the old consumer.
 */
export async function handleStationMessages(
  batch: MessageBatch<BcInboundQueueMessage>,
  env: Env,
  deps: StationDeps = defaultSyncDeps(),
): Promise<MessageBatch<BcInboundQueueMessage>> {
  const rest: Message<BcInboundQueueMessage>[] = []
  for (const message of batch.messages) {
    const body = message.body
    try {
      if (body.kind === 'station_sync') {
        await runStation(env, body.linkId, deps)
        message.ack()
        continue
      }
      if (body.kind === 'basecamp_webhook') {
        const links = await env.DB.prepare(`SELECT id FROM station_links WHERE bc_project_id = ?1 AND state = 'active'`).bind(body.bcProjectId).all<{ id: string }>()
        if (links.results.length > 0) {
          for (const l of links.results) await requestRun(env, l.id, 'basecamp')
          message.ack()
          continue
        }
      }
      rest.push(message)
    } catch (error) {
      console.error(`station: message failed (${error instanceof Error ? error.name : 'unknown'})`)
      message.retry()
    }
  }
  return { ...batch, messages: rest, ackAll: () => rest.forEach((m) => m.ack()), retryAll: (o) => rest.forEach((m) => m.retry(o)) } as MessageBatch<BcInboundQueueMessage>
}
