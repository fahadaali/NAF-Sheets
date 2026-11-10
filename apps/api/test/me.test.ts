import { describe, expect, it } from 'vitest'
import { call, isArabic, json, seedMember, testApp } from './helpers'

const app = testApp()

describe('GET /api/me', () => {
  it('returns the signed-in user with the platform role from members', async () => {
    for (const role of ['admin', 'editor', 'viewer'] as const) {
      const member = await seedMember(role)
      const res = await call(app, 'GET', '/api/me', { user: member })
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(await res.json()).toEqual({ user: { id: member.id, name: member.name, email: member.email, role } })
    }
  })

  it('answers 401 with an Arabic ApiError without a user', async () => {
    const res = await call(app, 'GET', '/api/me')
    expect(res.status).toBe(401)
    const body = await json(res)
    expect(body).toMatchObject({ ok: false, error: 'unauthorized' })
    expect(isArabic(body.message)).toBe(true)
  })

  it('answers unknown routes with an Arabic 404', async () => {
    const member = await seedMember('viewer')
    const res = await call(app, 'GET', '/api/nothing-here', { user: member })
    expect(res.status).toBe(404)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await json(res)
    expect(body.error).toBe('not_found')
    expect(isArabic(body.message)).toBe(true)
  })
})
