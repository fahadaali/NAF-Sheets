import { describe, expect, it, vi } from 'vitest'
import {
  ApiRequestError,
  createApiClient,
  isSafeNext,
  loginRedirectUrl,
  toApiRequestError,
} from '../../src/lib/api'
import { t } from '../../src/strings'

type Call = { url: string; init: RequestInit }

function fakeFetch(status: number, body: unknown, calls: Call[] = []) {
  return async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
    return new Response(text, { status, headers: { 'content-type': 'application/json' } })
  }
}

const ARABIC = /[؀-ۿ]/

describe('createApiClient — requests', () => {
  it('calls GET /api/me', async () => {
    const calls: Call[] = []
    const client = createApiClient({ fetch: fakeFetch(200, { user: { id: 'u', name: null, email: null, role: 'editor' } }, calls) })
    await client.me()
    expect(calls[0]?.url).toBe('/api/me')
  })
})

describe('createApiClient — errors', () => {
  it('uses the API Arabic message and code', async () => {
    const client = createApiClient({ fetch: fakeFetch(409, { ok: false, error: 'version_conflict', message: 'نسخة أحدث محفوظة؛ أعد التحميل.' }) })
    const error = await client.me().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiRequestError)
    expect(error).toMatchObject({ status: 409, code: 'version_conflict', message: 'نسخة أحدث محفوظة؛ أعد التحميل.' })
  })

  it('on 401 hands the login URL to onUnauthorized, then throws', async () => {
    const onUnauthorized = vi.fn()
    // naf-auth's 401 body carries no `message`.
    const client = createApiClient({
      fetch: fakeFetch(401, { ok: false, error: 'unauthorized', login: 'https://app.naflaw.sa/go/naf-sheets' }),
      onUnauthorized,
    })
    const error = await client.me().catch((e: unknown) => e)
    expect(onUnauthorized).toHaveBeenCalledWith('https://app.naflaw.sa/go/naf-sheets')
    expect(error).toMatchObject({ status: 401, code: 'unauthorized', message: t.errors.unauthorized })
  })

  it('does not call onUnauthorized for other statuses', async () => {
    const onUnauthorized = vi.fn()
    const client = createApiClient({ fetch: fakeFetch(403, { ok: false, error: 'forbidden', message: 'لا صلاحية.' }), onUnauthorized })
    await client.me().catch(() => undefined)
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('turns a network failure into an Arabic status-0 error', async () => {
    const client = createApiClient({
      fetch: async () => {
        throw new TypeError('Failed to fetch')
      },
    })
    const error = await client.me().catch((e: unknown) => e)
    expect(error).toMatchObject({ status: 0, code: 'network_error', message: t.errors.network })
  })

  it('lets an abort through untouched', async () => {
    const abort = new DOMException('aborted', 'AbortError')
    const client = createApiClient({
      fetch: async () => {
        throw abort
      },
    })
    await expect(client.me()).rejects.toBe(abort)
  })

  it('rejects a 2xx response that is not a JSON object', async () => {
    const client = createApiClient({ fetch: fakeFetch(200, '<html>login</html>') })
    await expect(client.me()).rejects.toMatchObject({ code: 'invalid_response', message: t.errors.invalidResponse })
  })

  it('falls back to an Arabic message for every status without one', () => {
    const cases: Array<[number, unknown, string]> = [
      [403, { ok: false, error: 'access_denied', reason: 'inactive', denied: '/denied?r=inactive' }, t.denied.reasons.inactive!],
      [403, { ok: false, error: 'access_denied', reason: 'something_new' }, t.errors.forbidden],
      [404, null, t.errors.notFound],
      [409, { ok: false, error: 'version_conflict' }, t.errors.conflict],
      [429, '', t.errors.tooManyRequests],
      [503, { ok: false, error: 'auth_unavailable' }, t.errors.authUnavailable],
      [502, '<html>bad gateway</html>', t.errors.server],
      [418, {}, t.errors.generic],
    ]
    for (const [status, body, message] of cases) {
      const error = toApiRequestError(status, body)
      expect(error.message).toBe(message)
      expect(error.message).toMatch(ARABIC)
    }
    expect(toApiRequestError(404, null).code).toBe('http_404')
    expect(toApiRequestError(400, { ok: false, error: 'bad', message: '   ' }).message).toBe(t.errors.generic)
  })
})

describe('sign-in redirect', () => {
  const at = (pathname: string, search = '') => ({ origin: 'https://sheets.naflaw.sa', pathname, search })

  it('attaches the current page as `next`', () => {
    const url = loginRedirectUrl('https://app.naflaw.sa/go/naf-sheets', at('/workbooks/wb-1'))
    expect(url).toBe('https://app.naflaw.sa/go/naf-sheets?next=%2Fworkbooks%2Fwb-1')
  })

  it('omits `next` for the root and keeps a `next` the server already set', () => {
    expect(loginRedirectUrl('https://app.naflaw.sa/go/x', at('/'))).toBe('https://app.naflaw.sa/go/x')
    expect(loginRedirectUrl('https://app.naflaw.sa/go/x?next=%2Fa', at('/b'))).toBe('https://app.naflaw.sa/go/x?next=%2Fa')
  })

  it('omits a `next` naf-auth would refuse (colon in the query)', () => {
    expect(loginRedirectUrl('https://app.naflaw.sa/go/x', at('/', '?q=a:b'))).toBe('https://app.naflaw.sa/go/x')
  })

  it('refuses a login URL that is not http(s)', () => {
    expect(loginRedirectUrl('javascript:alert(1)', at('/'))).toBeNull()
    expect(loginRedirectUrl('data:text/html,x', at('/'))).toBeNull()
  })

  it('resolves a relative login URL against the platform origin', () => {
    expect(loginRedirectUrl('/auth/start', at('/'))).toBe('https://sheets.naflaw.sa/auth/start')
  })

  it('isSafeNext follows naf-auth safeNext', () => {
    expect(isSafeNext('/workbooks/wb-1')).toBe(true)
    expect(isSafeNext('/?q=%D8%AE%D8%B7%D8%A9')).toBe(true)
    for (const bad of ['', 'workbooks', '//evil.sa', '/\\evil.sa', '/%2f%2fevil.sa', '/a:b', '/%3Ajavascript', '/a\tb', '/%E0%A4%A']) {
      expect(isSafeNext(bad), bad).toBe(false)
    }
  })
})
