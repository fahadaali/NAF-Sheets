// GET /api/me — the signed-in user (packages/shared/src/api.ts).

import { Hono } from 'hono'
import type { MeResponse } from '@naf-sheets/shared'
import type { AppEnv } from '../auth'
import { getMemberIdentity } from '../db'
import { ApiFailure } from '../errors'
import { callerOf } from '../request'

export function meRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  routes.get('/', async (c) => {
    const caller = callerOf(c)
    // naf-auth puts only { id, role, perms } in the context; name and email
    // are what naf-auth last wrote to members at sign-in (spec §13).
    const member = await getMemberIdentity(c.env.DB, caller.id)
    if (!member) throw new ApiFailure(401, 'unauthorized')
    return c.json<MeResponse>({ user: { id: caller.id, name: member.display_name, email: member.email, role: caller.role } })
  })

  return routes
}
