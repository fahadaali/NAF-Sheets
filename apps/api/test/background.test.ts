import { createExecutionContext, createMessageBatch, createScheduledController, getQueueResult, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { INBOUND_QUEUE, OUTBOUND_QUEUE, handleQueue, handleScheduled } from '../src/background'
import type { QueueMessageBody } from '../src/background'

const outbound: QueueMessageBody = { kind: 'task_changed', workbookId: 'w', taskUid: 't', actorUserId: 'u', enqueuedAt: '2026-11-10T08:00:00.000Z' }
const inbound: QueueMessageBody = { kind: 'basecamp_webhook', bcWebhookId: 1, bcProjectId: 2, receivedAt: '2026-11-10T08:00:00.000Z', body: '{}' }

describe('queue consumers and cron (phase 3/4 stubs)', () => {
  it('acknowledge bc-outbound and bc-inbound messages without effect', async () => {
    for (const [queue, body] of [
      [OUTBOUND_QUEUE, outbound],
      [INBOUND_QUEUE, inbound],
    ] as const) {
      const batch = createMessageBatch<QueueMessageBody>(queue, [{ id: 'm1', timestamp: new Date(), attempts: 1, body }])
      const ctx = createExecutionContext()
      await handleQueue(batch, env, ctx)
      const result = await getQueueResult(batch, ctx)
      expect(result.explicitAcks, queue).toEqual(['m1'])
      expect(result.retryMessages, queue).toEqual([])
    }
  })

  it('retries messages of a queue it does not know', async () => {
    const batch = createMessageBatch<QueueMessageBody>('some-other-queue', [{ id: 'm2', timestamp: new Date(), attempts: 1, body: outbound }])
    const ctx = createExecutionContext()
    await handleQueue(batch, env, ctx)
    const result = await getQueueResult(batch, ctx)
    expect(result.retryBatch.retry).toBe(true)
  })

  it('runs the 15-minute cron as a no-op', async () => {
    const ctx = createExecutionContext()
    await handleScheduled(createScheduledController({ cron: '*/15 * * * *', scheduledTime: Date.now() }), env, ctx)
    await waitOnExecutionContext(ctx)
  })
})
