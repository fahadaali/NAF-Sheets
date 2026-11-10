import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { BcInboundMessage, Env } from '../src/env'
import { call, isArabic, json, testApp } from './helpers'

const app = testApp()

function newSecret(): string {
  return `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll('-', '')
}

async function registerWebhook(): Promise<{ secret: string; bcWebhookId: number; bcProjectId: number }> {
  const secret = newSecret()
  const bcWebhookId = Math.floor(Math.random() * 1e12)
  const bcProjectId = Math.floor(Math.random() * 1e12)
  await env.DB.prepare(`INSERT INTO bc_webhooks (bc_webhook_id, bc_project_id, secret, types_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`)
    .bind(bcWebhookId, bcProjectId, secret, JSON.stringify(['Todo', 'Todolist', 'Kanban::Step', 'Comment', 'Upload']), new Date().toISOString())
    .run()
  return { secret, bcWebhookId, bcProjectId }
}

/** The real env with BC_INBOUND replaced by a recorder. */
function recordingEnv(): { env: Env; sent: BcInboundMessage[] } {
  const sent: BcInboundMessage[] = []
  const queue = {
    send: async (message: BcInboundMessage) => {
      sent.push(message)
    },
    sendBatch: async () => {},
  } as unknown as Queue<BcInboundMessage>
  return { env: { ...env, BC_INBOUND: queue }, sent }
}

const delivery = JSON.stringify({
  id: 9007199254740,
  kind: 'todo_created',
  details: {},
  created_at: '2026-11-10T08:00:00.000Z',
  recording: { id: 1, type: 'Todo', title: 'مهمة', bucket: { id: 2, name: 'مشروع', type: 'Project' } },
  creator: { id: 3, name: 'أحمد' },
})

describe('POST /webhooks/basecamp/:secret', () => {
  it('needs no session', async () => {
    const res = await call(app, 'POST', `/webhooks/basecamp/${newSecret()}`, { rawBody: delivery })
    // 404 for the unknown secret, not 401: the path is public.
    expect(res.status).toBe(404)
  })

  it('answers 404 for an unknown or malformed secret and queues nothing', async () => {
    const { env: recEnv, sent } = recordingEnv()
    for (const secret of [newSecret(), 'short', 'x'.repeat(200), 'has.dot.' + 'a'.repeat(40)]) {
      const res = await call(app, 'POST', `/webhooks/basecamp/${secret}`, { rawBody: delivery, env: recEnv })
      expect(res.status, secret).toBe(404)
      const body = await json(res)
      expect(body.error).toBe('not_found')
      expect(isArabic(body.message)).toBe(true)
    }
    expect(sent).toEqual([])
  })

  it('queues the raw delivery for a known secret and answers 200 at once', async () => {
    const hook = await registerWebhook()
    const { env: recEnv, sent } = recordingEnv()
    const res = await call(app, 'POST', `/webhooks/basecamp/${hook.secret}`, { rawBody: delivery, env: recEnv })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ kind: 'basecamp_webhook', bcWebhookId: hook.bcWebhookId, bcProjectId: hook.bcProjectId, body: delivery })
    expect(Number.isNaN(Date.parse(sent[0]!.receivedAt))).toBe(false)
  })

  it('queues even a body that is not JSON: validation belongs to the consumer', async () => {
    const hook = await registerWebhook()
    const { env: recEnv, sent } = recordingEnv()
    const res = await call(app, 'POST', `/webhooks/basecamp/${hook.secret}`, { rawBody: 'not json', env: recEnv })
    expect(res.status).toBe(200)
    expect(sent[0]?.body).toBe('not json')
  })

  it('works against the real local queue', async () => {
    const hook = await registerWebhook()
    const res = await call(app, 'POST', `/webhooks/basecamp/${hook.secret}`, { rawBody: delivery })
    expect(res.status).toBe(200)
  })

  it('answers 503 (so Basecamp retries) when the queue refuses the message', async () => {
    const hook = await registerWebhook()
    const failing = {
      ...env,
      BC_INBOUND: {
        send: async () => {
          throw new Error('queue down')
        },
      } as unknown as Queue<BcInboundMessage>,
    }
    const res = await call(app, 'POST', `/webhooks/basecamp/${hook.secret}`, { rawBody: delivery, env: failing })
    expect(res.status).toBe(503)
    expect(isArabic((await json(res)).message)).toBe(true)
  })
})
