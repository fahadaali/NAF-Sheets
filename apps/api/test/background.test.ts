import { createExecutionContext, createMessageBatch, createScheduledController, getQueueResult, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { INBOUND_QUEUE, OUTBOUND_QUEUE, handleQueue, handleScheduled } from '../src/background'
import type { QueueMessageBody } from '../src/background'

// The dispatcher with the Worker's own dependencies. The test env has no
// Basecamp configuration, so nothing here can reach Basecamp; the sync work
// itself is covered with a fake Basecamp in test/sync/.
const outbound: QueueMessageBody = { kind: 'task_changed', workbookId: 'w', taskUid: 't', actorUserId: 'u', enqueuedAt: '2026-11-10T08:00:00.000Z' }
const inbound: QueueMessageBody = { kind: 'basecamp_webhook', bcWebhookId: 1, bcProjectId: 2, receivedAt: '2026-11-10T08:00:00.000Z', body: '{}' }
const reconcile: QueueMessageBody = { kind: 'reconcile', workbookId: 'w', requestedBy: 'u', enqueuedAt: '2026-11-10T08:00:00.000Z' }

describe('queue consumers and cron', () => {
  it('acknowledge messages for unknown tasks, webhooks and workbooks without calling Basecamp', async () => {
    for (const [queue, body] of [
      [OUTBOUND_QUEUE, outbound],
      [INBOUND_QUEUE, inbound],
      [INBOUND_QUEUE, reconcile],
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

  it('runs the 15-minute reconciliation, which stops quietly while Basecamp is not configured', async () => {
    const ctx = createExecutionContext()
    await handleScheduled(createScheduledController({ cron: '*/15 * * * *', scheduledTime: Date.now() }), env, ctx)
    await waitOnExecutionContext(ctx)
  })
})
