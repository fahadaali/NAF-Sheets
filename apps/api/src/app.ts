// The Hono application. Built by a factory so tests can inject the auth
// middleware (they set a user directly and never call naf-id).

import { Hono } from 'hono'
import { handleBackchannelLogout, handleCallback, handleLogout } from 'naf-auth'
import type { AppEnv, AuthMiddleware } from './auth'
import { authConfig, nafAuthMiddleware } from './auth'
import { ApiFailure, errorBody } from './errors'
import { meRoutes } from './routes/me'
import { webhookRoutes } from './routes/webhooks'
import { workbookRoutes } from './routes/workbooks'
import { DEFAULT_SNAPSHOT_ORPHAN_AGE_MS } from './snapshot'

export interface AppOptions {
  /** Guards every non-public route. Default: naf-auth (`nafAuthMiddleware`). */
  auth?: AuthMiddleware
  /** See DEFAULT_SNAPSHOT_ORPHAN_AGE_MS. */
  snapshotOrphanAgeMs?: number
}

export function createApp(options: AppOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.onError((error, c) => {
    if (error instanceof ApiFailure) return c.json(errorBody(error.key), error.status)
    // Never echo internals: name only, no message (it may hold user data).
    console.error(`unhandled ${error.name} on ${c.req.method} ${new URL(c.req.url).pathname}`)
    return c.json(errorBody('internal'), 500)
  })
  app.notFound((c) => c.json(errorBody('route_not_found'), 404))

  // ── Public: registered before the guard, and listed in PUBLIC_PATHS /
  //    PUBLIC_PREFIXES so naf-auth treats them as public too.
  app.get('/health', (c) => c.json({ ok: true }))
  app.get('/auth/callback', (c) => handleCallback(c.req.raw, c.env, authConfig(c.env)))
  app.post('/auth/logout', (c) => handleLogout(c.req.raw, c.env, authConfig(c.env)))
  // All methods: naf-auth answers anything but POST with its own 405.
  app.all('/auth/backchannel-logout', (c) => handleBackchannelLogout(c.req.raw, c.env, authConfig(c.env)))
  app.route('/webhooks', webhookRoutes())

  // ── Everything else is protected.
  app.use('*', options.auth ?? nafAuthMiddleware)

  // Private data: never stored by the browser or an intermediary.
  // (A 101 WebSocket answer comes from the room with immutable headers.)
  app.use('/api/*', async (c, next) => {
    await next()
    if (c.res.status !== 101) c.res.headers.set('cache-control', 'no-store')
  })

  app.route('/api/me', meRoutes())
  app.route('/api/workbooks', workbookRoutes({ snapshotOrphanAgeMs: options.snapshotOrphanAgeMs ?? DEFAULT_SNAPSHOT_ORPHAN_AGE_MS }))

  return app
}
