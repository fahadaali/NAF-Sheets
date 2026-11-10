// Small helpers shared by the route modules.

import type { Context } from 'hono'
import type { AppEnv } from './auth'
import { platformRole } from './auth'
import type { Caller } from './access'
import { ApiFailure } from './errors'

/** The signed-in caller, with the platform role normalised. */
export function callerOf(c: Context<AppEnv>): Caller {
  const user = c.get('user')
  if (!user || typeof user.id !== 'string' || user.id === '') throw new ApiFailure(401, 'unauthorized')
  return { id: user.id, role: platformRole(user.role) }
}

/** Parsed JSON body; 400 `invalid_json` when it is not JSON. */
export async function readJson(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json<unknown>()
  } catch {
    throw new ApiFailure(400, 'invalid_json')
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function nowIso(): string {
  return new Date().toISOString()
}
