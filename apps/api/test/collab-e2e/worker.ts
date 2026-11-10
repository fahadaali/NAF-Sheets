// Test-only entry of the real API Worker for the browser collaboration check
// (apps/web/test/e2e/collab.test.ts), run locally by wrangler (`unstable_dev`, local
// Miniflare, no network) with apps/api/wrangler.toml's bindings. Never
// deployed: wrangler.toml's `main` is src/index.ts.
//
// The only differences from production:
// - sign-in: instead of naf-id, the member id comes from the `x-test-user`
//   header (or, for the room's WebSocket, the `test-user` query parameter),
//   and the member row is read exactly as naf-auth reads it (`getMember`);
// - POST /__test/exec runs SQL statements (migrations and members).

import { getMember } from 'naf-auth'
import { createApp } from '../../src/app'
import { authConfig } from '../../src/auth'
import type { AuthMiddleware } from '../../src/auth'
import type { Env } from '../../src/env'
import { errorBody } from '../../src/errors'
import { setOutboundDetection } from '../../src/room/outbound-seam'
import { detectAfterRoomCommit } from '../../src/sync/room-commit'

export { WorkbookRoom } from '../../src/room'
// Bound in wrangler.toml (the Basecamp rate gate): every bound class must be exported.
export { BasecampRateGate } from '../../src/basecamp-rate-gate'

const testAuth: AuthMiddleware = async (c, next) => {
  const userId = c.req.header('x-test-user') ?? new URL(c.req.url).searchParams.get('test-user')
  if (!userId) return c.json(errorBody('unauthorized'), 401)
  const member = await getMember(c.env, authConfig(c.env), userId)
  if (!member || !member.isActive) return c.json(errorBody('access_denied'), 403)
  c.set('user', { id: member.id, role: member.role, perms: member.perms })
  await next()
}

const app = createApp({ auth: testAuth })
// As src/index.ts does.
setOutboundDetection(detectAfterRoomCommit)

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/__test/exec' && request.method === 'POST') {
      const { statements } = (await request.json()) as { statements: string[] }
      for (const sql of statements) await env.DB.prepare(sql).run()
      return new Response('ok')
    }
    return app.fetch(request, env, ctx)
  },
} satisfies ExportedHandler<Env>
