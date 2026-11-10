import { describe, expect, it } from 'vitest'
import { decryptJson, encryptJson } from '../src/crypto'

const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const otherKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))

describe('token encryption (AES-GCM)', () => {
  it('round-trips a token object', async () => {
    const tokens = { access_token: 'a-secret', refresh_token: 'r-secret', expires_at: '2026-12-01T00:00:00Z' }
    const sealed = await encryptJson(key, tokens, 'user:u1')
    expect(sealed.startsWith('v1:')).toBe(true)
    expect(sealed).not.toContain('a-secret')
    expect(await decryptJson(key, sealed, 'user:u1')).toEqual(tokens)
  })

  it('uses a fresh IV every time', async () => {
    const a = await encryptJson(key, { t: 1 }, 'x')
    const b = await encryptJson(key, { t: 1 }, 'x')
    expect(a).not.toBe(b)
  })

  it('refuses another row (aad), another key, or a tampered value', async () => {
    const sealed = await encryptJson(key, { t: 'secret' }, 'user:u1')
    await expect(decryptJson(key, sealed, 'user:u2')).rejects.toThrow()
    await expect(decryptJson(otherKey, sealed, 'user:u1')).rejects.toThrow()
    const tampered = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'B' : 'A') + sealed.slice(-1)
    await expect(decryptJson(key, tampered, 'user:u1')).rejects.toThrow()
  })

  it('rejects a key that is not 32 bytes and an unknown format', async () => {
    await expect(encryptJson(btoa('short'), {}, 'x')).rejects.toThrow(/32 bytes/)
    await expect(decryptJson(key, 'v0:abc:def', 'x')).rejects.toThrow(/format/)
  })
})
