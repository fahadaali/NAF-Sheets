// The station's Google client against a recorded fake (nothing remote is called).

import { describe, expect, it } from 'vitest'
import {
  GoogleClient,
  GoogleError,
  ROW_UID_KEY,
  a1,
  googleErrorMessage,
  parseServiceAccountKey,
  quoteTab,
  signAssertion,
  type ServiceAccountKey,
} from '../../src/station/google'

const EMAIL = 'naf-sync@naf-sheets-station.iam.gserviceaccount.com'

async function testKey(): Promise<{ key: ServiceAccountKey; publicKey: CryptoKey; json: string }> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer)
  let bin = ''
  for (const b of der) bin += String.fromCharCode(b)
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(bin).replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`
  const json = JSON.stringify({ type: 'service_account', client_email: EMAIL, private_key: pem, token_uri: 'https://oauth2.googleapis.com/token' })
  return { key: parseServiceAccountKey(json), publicKey: pair.publicKey, json }
}

const fromB64url = (s: string): Uint8Array =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0))

interface Call {
  url: string
  method: string
  auth: string | null
  body: string | null
}

function fakeGoogle(routes: (call: Call) => Response): { fetch: (u: string, i?: RequestInit) => Promise<Response>; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    fetch: async (url, init) => {
      const call: Call = {
        url,
        method: init?.method ?? 'GET',
        auth: new Headers(init?.headers).get('Authorization'),
        body: typeof init?.body === 'string' ? init.body : null,
      }
      calls.push(call)
      if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'tok-1', expires_in: 3600 })
      return routes(call)
    },
  }
}

describe('service account key', () => {
  it('refuses a missing or wrong key with an Arabic message', () => {
    expect(() => parseServiceAccountKey(undefined)).toThrow(GoogleError)
    expect(() => parseServiceAccountKey('{"type":"authorized_user"}')).toThrow('key_invalid')
    expect(googleErrorMessage('key_missing')).toContain('GOOGLE_SERVICE_ACCOUNT_KEY')
    expect(googleErrorMessage('file_not_accessible', EMAIL)).toContain(EMAIL)
  })

  it('signs a verifiable RS256 assertion for the token endpoint', async () => {
    const { key, publicKey } = await testKey()
    const jwt = await signAssertion(key, ['scope-a', 'scope-b'], 1_763_200_000)
    const [h, c, s] = jwt.split('.')
    expect(JSON.parse(new TextDecoder().decode(fromB64url(h!)))).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(JSON.parse(new TextDecoder().decode(fromB64url(c!)))).toEqual({
      iss: EMAIL,
      scope: 'scope-a scope-b',
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_763_200_000,
      exp: 1_763_203_600,
    })
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, fromB64url(s!), new TextEncoder().encode(`${h}.${c}`))
    expect(valid).toBe(true)
  })
})

describe('GoogleClient', () => {
  it('reads tab values unformatted and caches the token', async () => {
    const { key } = await testKey()
    const g = fakeGoogle(() => Response.json({ valueRanges: [{ values: [['المهمة الرئيسية']] }, {}] }))
    const client = new GoogleClient({ key, fetch: g.fetch, now: () => 1_763_200_000_000 })
    const values = await client.tabValues('SID', ['السوشل ميديا', "تبويب 'خاص'"])
    await client.tabValues('SID', ['عام'])
    expect(values.get('السوشل ميديا')).toEqual([['المهمة الرئيسية']])
    expect(values.get("تبويب 'خاص'")).toEqual([])
    expect(g.calls.filter((c) => c.url.includes('oauth2')).length).toBe(1)
    const read = new URL(g.calls[1]!.url)
    expect(read.pathname).toBe('/v4/spreadsheets/SID/values:batchGet')
    expect(read.searchParams.getAll('ranges')).toEqual(["'السوشل ميديا'", "'تبويب ''خاص'''"])
    expect(read.searchParams.get('valueRenderOption')).toBe('UNFORMATTED_VALUE')
    expect(read.searchParams.get('dateTimeRenderOption')).toBe('SERIAL_NUMBER')
    expect(g.calls[1]!.auth).toBe('Bearer tok-1')
  })

  it('reads row identities from developer metadata', async () => {
    const { key } = await testKey()
    const g = fakeGoogle(() =>
      Response.json({
        matchedDeveloperMetadata: [
          { developerMetadata: { metadataId: 7, metadataValue: 'u1', location: { dimensionRange: { sheetId: 1506883657, dimension: 'ROWS', startIndex: 3, endIndex: 4 } } } },
          { developerMetadata: { metadataId: 8, metadataValue: 'col', location: { dimensionRange: { sheetId: 1, dimension: 'COLUMNS', startIndex: 0 } } } },
        ],
      }),
    )
    const ids = await new GoogleClient({ key, fetch: g.fetch }).rowIdentities('SID')
    expect(ids).toEqual([{ sheetId: 1506883657, row: 3, uid: 'u1', metadataId: 7 }])
    expect(JSON.parse(g.calls[1]!.body!)).toEqual({ dataFilters: [{ developerMetadataLookup: { metadataKey: ROW_UID_KEY } }] })
  })

  it('writes identities, then cells as USER_ENTERED', async () => {
    const { key } = await testKey()
    const g = fakeGoogle(() => Response.json({}))
    await new GoogleClient({ key, fetch: g.fetch }).write('SID', {
      identities: [{ sheetId: 9, row: 2, uid: 'u2' }],
      cells: [{ tabTitle: 'عام', row: 2, column: 3, value: 'منجزة' }],
    })
    const meta = JSON.parse(g.calls[1]!.body!)
    expect(g.calls[1]!.url).toBe('https://sheets.googleapis.com/v4/spreadsheets/SID:batchUpdate')
    expect(meta.requests[0].createDeveloperMetadata.developerMetadata).toMatchObject({
      metadataKey: ROW_UID_KEY,
      metadataValue: 'u2',
      visibility: 'PROJECT',
      location: { dimensionRange: { sheetId: 9, dimension: 'ROWS', startIndex: 2, endIndex: 3 } },
    })
    expect(JSON.parse(g.calls[2]!.body!)).toEqual({ valueInputOption: 'USER_ENTERED', data: [{ range: "'عام'!D3", values: [['منجزة']] }] })
  })

  it('maps an unshared file and quota errors to codes', async () => {
    const { key } = await testKey()
    const notShared = new GoogleClient({ key, fetch: fakeGoogle(() => new Response('{"error":{"status":"PERMISSION_DENIED"}}', { status: 403 })).fetch })
    await expect(notShared.tabValues('SID', ['عام'])).rejects.toMatchObject({ code: 'file_not_accessible' })
    const quota = new GoogleClient({ key, fetch: fakeGoogle(() => new Response('{"error":{"status":"RESOURCE_EXHAUSTED","reason":"rateLimitExceeded"}}', { status: 403 })).fetch })
    await expect(quota.tabValues('SID', ['عام'])).rejects.toMatchObject({ code: 'rate_limited' })
  })

  it('opens a Drive push channel for the file', async () => {
    const { key } = await testKey()
    const g = fakeGoogle(() => Response.json({ id: 'ch1', resourceId: 'res1', expiration: '1763286400000' }))
    const ch = await new GoogleClient({ key, fetch: g.fetch, now: () => 1_763_200_000_000 }).watch('SID', {
      id: 'ch1',
      address: 'https://sheets.naflaw.sa/webhooks/google/secret',
      token: 'link-1',
      ttlMs: 86_400_000,
    })
    expect(ch).toEqual({ id: 'ch1', resourceId: 'res1', expiration: 1763286400000 })
    expect(JSON.parse(g.calls[1]!.body!)).toMatchObject({ type: 'web_hook', address: 'https://sheets.naflaw.sa/webhooks/google/secret', expiration: '1763286400000' })
  })
})

describe('A1 helpers', () => {
  it('quotes tabs and names cells', () => {
    expect(a1(0, 0)).toBe('A1')
    expect(a1(4, 27)).toBe('AB5')
    expect(quoteTab("a'b")).toBe("'a''b'")
  })
})
