import { describe, expect, it } from 'vitest'
import type { LinkPlan } from '@naf-sheets/shared'
import { ApiRequestError, basecampStartUrl, createApiClient, googleStartUrl } from '../../src/lib/api'

type Call = { url: string; init: RequestInit }

function fakeFetch(status: number, body: unknown, calls: Call[] = []) {
  return async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
    return new Response(status === 204 ? null : text, { status, headers: { 'content-type': 'application/json' } })
  }
}

const bodyOf = (call: Call | undefined) => (call?.init.body === undefined ? undefined : JSON.parse(String(call.init.body)))

describe('wave 2 endpoints (packages/shared/src/api-integrations.ts)', () => {
  it('Basecamp link: GET, and revoke as a POST without a body', async () => {
    const calls: Call[] = []
    const client = createApiClient({ fetch: fakeFetch(200, { state: 'revoked' }, calls) })
    await client.getBasecampLink()
    await client.revokeBasecampLink()
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ['GET', '/api/basecamp/link'],
      ['POST', '/api/basecamp/link/revoke'],
    ])
    expect(calls[1]?.init.body).toBeUndefined()
  })

  it('Basecamp projects, lists and people', async () => {
    const calls: Call[] = []
    const client = createApiClient({ fetch: fakeFetch(200, {}, calls) })
    await client.listBasecampProjects()
    await client.listBasecampTodolists(42)
    await client.listBasecampPeople(42)
    expect(calls.map((c) => c.url)).toEqual(['/api/basecamp/projects', '/api/basecamp/projects/42/todolists', '/api/basecamp/projects/42/people'])
  })

  it('link preview and link POST the plan as given', async () => {
    const calls: Call[] = []
    const client = createApiClient({ fetch: fakeFetch(200, { sheets: [] }, calls) })
    const plan: LinkPlan = { project: { mode: 'create', name: 'خطة' }, sheets: [] }
    await client.previewLink('a/b', plan)
    await client.linkWorkbook('a/b', plan)
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ['POST', '/api/workbooks/a%2Fb/link/preview'],
      ['POST', '/api/workbooks/a%2Fb/link'],
    ])
    expect(bodyOf(calls[0])).toEqual(plan)
    expect(bodyOf(calls[1])).toEqual(plan)
  })

  it('Google link, import and the import report', async () => {
    const calls: Call[] = []
    const client = createApiClient({ fetch: fakeFetch(200, {}, calls) })
    await client.getGoogleLink()
    await client.importGsheets({ source: 'abc', title: 'خطة' })
    await client.getImportReport('wb 1')
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ['GET', '/api/google/link'],
      ['POST', '/api/import/gsheets'],
      ['GET', '/api/workbooks/wb%201/import-report'],
    ])
    expect(bodyOf(calls[1])).toEqual({ source: 'abc', title: 'خطة' })
  })

  it('people matches: GET, and PUT with the contract body whose success may be empty', async () => {
    const calls: Call[] = []
    await createApiClient({ fetch: fakeFetch(200, { matches: [], people: [] }, calls) }).getPeopleMatches()
    await expect(createApiClient({ fetch: fakeFetch(204, undefined, calls) }).putPeopleMatch('u/1', { bcPersonId: 9 })).resolves.toBeUndefined()
    await expect(createApiClient({ fetch: fakeFetch(200, { ok: true }, calls) }).putPeopleMatch('u-2', { bcPersonId: null })).resolves.toBeUndefined()
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ['GET', '/api/admin/people-matches'],
      ['PUT', '/api/admin/people-matches/u%2F1'],
      ['PUT', '/api/admin/people-matches/u-2'],
    ])
    expect(bodyOf(calls[1])).toEqual({ bcPersonId: 9 })
    expect(bodyOf(calls[2])).toEqual({ bcPersonId: null })
  })

  it('an empty 2xx is still an error where the contract promises a body', async () => {
    const client = createApiClient({ fetch: fakeFetch(204, undefined) })
    await expect(client.getBasecampLink()).rejects.toBeInstanceOf(ApiRequestError)
  })
})

describe('account-link navigations', () => {
  it('send the current page as `next`', () => {
    expect(basecampStartUrl('/workbooks/wb-1')).toBe('/auth/basecamp/start?next=%2Fworkbooks%2Fwb-1')
    expect(googleStartUrl('/?import=1AbC')).toBe('/auth/google/start?next=%2F%3Fimport%3D1AbC')
  })

  it('fall back to the files screen for anything that is not a safe same-site path', () => {
    for (const bad of ['', 'https://evil.example/', '//evil.example', '/\\evil', '/a:b', '/%2F%2Fevil.example']) {
      expect(basecampStartUrl(bad), bad).toBe('/auth/basecamp/start?next=%2F')
      expect(googleStartUrl(bad), bad).toBe('/auth/google/start?next=%2F')
    }
  })
})
