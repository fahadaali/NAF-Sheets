import { describe, expect, it } from 'vitest'
import { call, isArabic, json, seedMember, testApp } from './helpers'

describe('appearance «المظهر»', () => {
  it('is read by everyone signed in and changed by admins only, with Arabic refusals', async () => {
    const app = testApp()
    const admin = await seedMember('admin')
    const viewer = await seedMember('viewer')
    expect((await call(app, 'GET', '/api/appearance', { user: viewer })).status).toBe(200)
    const refused = await call(app, 'PUT', '/api/admin/appearance', { user: viewer, body: { palette: {} } })
    expect(refused.status).toBe(403)
    expect(isArabic((await json<{ message: string }>(refused)).message)).toBe(true)
    const invalid = await call(app, 'PUT', '/api/admin/appearance', { user: admin, body: { palette: 'red' } })
    expect(invalid.status).toBe(400)
    expect((await call(app, 'PUT', '/api/admin/appearance', { user: admin, body: { palette: {} } })).status).toBe(200)
  })
})
