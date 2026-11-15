// Queue consumer and cron triggers: dispatch only. The work lives in
// src/station (docs/station-plan.md §4) and src/phase7 (backups).

import type { BcInboundQueueMessage, Env } from './env'
import { runBackup } from './phase7'
import { handleStationMessages, stationMinute } from './station'

export const INBOUND_QUEUE = 'bc-inbound'

export type QueueMessageBody = BcInboundQueueMessage

/**
 * `bc-inbound`: the station's runs, and Basecamp webhook deliveries (a
 * delivery for a project the station links becomes a run of its links).
 * Anything else, e.g. a message left by the removed editor, is acknowledged
 * and dropped. Payloads are never logged (§14).
 */
export async function handleQueue(batch: MessageBatch<QueueMessageBody>, env: Env): Promise<void> {
  if (batch.queue !== INBOUND_QUEUE) {
    console.error(`queue consumer: unknown queue ${batch.queue}`)
    batch.ackAll()
    return
  }
  const rest = await handleStationMessages(batch, env)
  for (const message of rest.messages) message.ack()
}

/** The daily backup's cron (spec §14): 00:23 UTC = 03:23 in Riyadh. */
export const BACKUP_CRON = '23 0 * * *'

/** The station's minute check (docs/station-plan.md §4.1: under a minute, owner decision 8). */
export const STATION_CRON = '* * * * *'

export async function handleScheduled(controller: ScheduledController, env: Env): Promise<void> {
  if (controller.cron === BACKUP_CRON) {
    await runBackup(env, new Date(controller.scheduledTime))
    return
  }
  await stationMinute(env)
}
