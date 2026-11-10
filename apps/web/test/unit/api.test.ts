import { describe, expect, it, vi } from 'vitest'
import {
  ApiRequestError,
  classifySaveError,
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
  it('lists workbooks, encoding the search and omitting an empty one', async () => {
    const calls: Call[] = []
    const client = createApiClient({ fetch: fakeFetch(200, { workbooks: [] }, calls) })
    await client.listWorkbooks('  خطة الربع/1&2 ')
    await client.listWorkbooks('   ')
    expect(calls[0]?.url).toBe(`/api/workbooks?q=${encodeURIComponent('خطة الربع/1&2')}`)
    expect(calls[1]?.url).toBe('/api/workbooks')
    expect(calls[0]?.init.method).toBe('GET')
    expect(calls[0]?.init.credentials).toBe('same-origin')
    expect((calls[0]?.init.headers as Record<string, string>).Accept).toBe('application/json')
    expect(calls[0]?.init.body).toBeUndefined()
  })

  it('creates a blank workbook with exactly the contract body', async () => {
    const calls: Call[] = []
    const client = createApiClient({ fetch: fakeFetch(201, { id: 'wb-9' }, calls) })
    await expect(client.createWorkbook('خطة الاتصال')).resolves.toEqual({ id: 'wb-9' })
    expect(calls[0]?.url).toBe('/api/workbooks')
    expect(calls[0]?.init.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ title: 'خطة الاتصال', source: 'blank' })
    expect((calls[0]?.init.headers as Record<string, string>)['Content-Type']).toBe('application/json; charset=utf-8')
  })

  it('reads a workbook and saves a snapshot with baseVersion at the encoded path', async () => {
    const calls: Call[] = []
    const client = createApiClient({ fetch: fakeFetch(200, { version: 8 }, calls) })
    await client.getWorkbook('a/b c')
    await expect(client.saveSnapshot('a/b c', { baseVersion: 7, snapshot: { id: 'x' } })).resolves.toEqual({ version: 8 })
    expect(calls[0]?.url).toBe('/api/workbooks/a%2Fb%20c')
    expect(calls[1]?.url).toBe('/api/workbooks/a%2Fb%20c/snapshot')
    expect(calls[1]?.init.method).toBe('PUT')
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ baseVersion: 7, snapshot: { id: 'x' } })
  })

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
    const error = await client.saveSnapshot('wb', { baseVersion: 1, snapshot: {} }).catch((e: unknown) => e)
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
    const error = await client.listWorkbooks('').catch((e: unknown) => e)
    expect(onUnauthorized).toHaveBeenCalledWith('https://app.naflaw.sa/go/naf-sheets')
    expect(error).toMatchObject({ status: 401, code: 'unauthorized', message: t.errors.unauthorized })
  })

  it('does not call onUnauthorized for other statuses', async () => {
    const onUnauthorized = vi.fn()
    const client = createApiClient({ fetch: fakeFetch(403, { ok: false, error: 'forbidden', message: 'لا صلاحية.' }), onUnauthorized })
    await client.listWorkbooks('').catch(() => undefined)
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('turns a network failure into an Arabic status-0 error', async () => {
    const client = createApiClient({
      fetch: async () => {
        throw new TypeError('Failed to fetch')
      },
    })
    const error = await client.getWorkbook('wb').catch((e: unknown) => e)
    expect(error).toMatchObject({ status: 0, code: 'network_error', message: t.errors.network })
  })

  it('lets an abort through untouched', async () => {
    const abort = new DOMException('aborted', 'AbortError')
    const client = createApiClient({
      fetch: async () => {
        throw abort
      },
    })
    await expect(client.getWorkbook('wb')).rejects.toBe(abort)
  })

  it('rejects a 2xx response that is not a JSON object', async () => {
    const client = createApiClient({ fetch: fakeFetch(200, '<html>login</html>') })
    await expect(client.getWorkbook('wb')).rejects.toMatchObject({ code: 'invalid_response', message: t.errors.invalidResponse })
  })

  it('falls back to an Arabic message for every status without one', () => {
    const cases: Array<[number, unknown, string]> = [
      [403, { ok: false, error: 'access_denied', reason: 'inactive', denied: '/denied?r=inactive' }, t.denied.reasons.inactive!],
      [403, { ok: false, error: 'access_denied', reason: 'something_new' }, t.errors.forbidden],
      [404, null, t.errors.notFound],
      [409, { ok: false, error: 'version_conflict' }, t.editor.conflictFallback],
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

describe('classifySaveError', () => {
  it('stops on 409, retries transient failures, waits for the user otherwise', () => {
    expect(classifySaveError(new ApiRequestError(409, 'version_conflict', 'م'))).toEqual({ kind: 'conflict', message: 'م' })
    for (const status of [0, 429, 500, 503]) expect(classifySaveError(new ApiRequestError(status, 'x', 'م')).kind).toBe('retryable')
    for (const status of [400, 401, 403, 404, 413]) expect(classifySaveError(new ApiRequestError(status, 'x', 'م')).kind).toBe('fatal')
    expect(classifySaveError(new Error('boom'))).toEqual({ kind: 'fatal', message: t.errors.generic })
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
