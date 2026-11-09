// Phase 0 webhook recorder. Stores every Basecamp webhook delivery verbatim so
// the live test can see exactly which `kind` arrives for each change made in
// the Basecamp UI. Spike code — not the production webhook handler.
//
//   POST /webhooks/basecamp/:secret   Basecamp delivers here (secret in path, §9.3.2)
//   GET  /events                      Authorization: Bearer <READ_TOKEN>
//
// Responds 200 immediately: Basecamp retries non-2xx up to 10 times and then
// deactivates the webhook, and never follows a 3xx.

const EVENT_TTL_SECONDS = 14 * 24 * 3600

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const parts = url.pathname.split('/').filter(Boolean)

    if (request.method === 'POST' && parts[0] === 'webhooks' && parts[1] === 'basecamp' && parts.length === 3) {
      if (!timingSafeEqual(parts[2], env.RECORDER_SECRET)) return new Response('not found', { status: 404 })
      const raw = await request.text()
      const receivedAt = new Date().toISOString()
      const key = `evt:${receivedAt}:${crypto.randomUUID()}`
      await env.EVENTS.put(key, JSON.stringify({ receivedAt, raw }), { expirationTtl: EVENT_TTL_SECONDS })
      return new Response('ok', { status: 200 })
    }

    if (request.method === 'GET' && url.pathname === '/events') {
      const auth = request.headers.get('authorization') ?? ''
      if (!timingSafeEqual(auth, `Bearer ${env.READ_TOKEN}`)) return new Response('unauthorized', { status: 401 })
      const events = []
      let cursor
      do {
        const page = await env.EVENTS.list({ prefix: 'evt:', cursor })
        for (const k of page.keys) {
          const stored = await env.EVENTS.get(k.name)
          if (stored) events.push(JSON.parse(stored))
        }
        cursor = page.list_complete ? undefined : page.cursor
      } while (cursor)
      events.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
      return Response.json(events)
    }

    return new Response('not found', { status: 404 })
  },
}
