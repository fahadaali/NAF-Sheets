import { createMessageBatch, createScheduledController, getQueueResult, createExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { INBOUND_QUEUE, STATION_CRON, handleQueue, handleScheduled } from '../src/background'
import type { QueueMessageBody } from '../src/background'

// The dispatcher with the Worker's own dependencies. Nothing here can reach
// Basecamp or Google; the station's work is covered in test/station/.
const webhook: QueueMessageBody = { kind: 'basecamp_webhook', bcWebhookId: 1, bcProjectId: 2, receivedAt: '2026-11-10T08:00:00.000Z', body: '{}' }
const old = { kind: 'task_changed', workbookId: 'w', taskUid: 't', actorUserId: 'u', enqueuedAt: '2026-11-10T08:00:00.000Z' } as unknown as QueueMessageBody

describe('queue consumer and cron', () => {
  it('acknowledges a webhook of a project no link uses, and a message left by the removed editor', async () => {
    const batch = createMessageBatch<QueueMessageBody>(INBOUND_QUEUE, [
      { id: 'm1', timestamp: new Date(), attempts: 1, body: webhook },
      { id: 'm2', timestamp: new Date(), attempts: 1, body: old },
    ])
    const ctx = createExecutionContext()
    await handleQueue(batch, env)
    const result = await getQueueResult(batch, ctx)
    expect([...result.explicitAcks].sort()).toEqual(['m1', 'm2'])
    expect(result.retryMessages).toEqual([])
  })

  it('acknowledges and drops messages of a queue it does not know (the old bc-outbound)', async () => {
    const batch = createMessageBatch<QueueMessageBody>('bc-outbound', [{ id: 'm3', timestamp: new Date(), attempts: 1, body: old }])
    const ctx = createExecutionContext()
    await handleQueue(batch, env)
    const result = await getQueueResult(batch, ctx)
    expect(result.ackAll).toBe(true)
  })

  it('runs the minute check, which stops quietly with no link and no keys', async () => {
    await handleScheduled(createScheduledController({ cron: STATION_CRON, scheduledTime: Date.now() }), env)
  })
})
