// Linking-wizard data (spec §7.3, §9.5): projects, to-do lists through the
// project's to-do set, and project people from bc_people_cache — every call
// with the CALLER's own token.

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { BasecampPeopleResponse, BasecampProjectsResponse, BasecampTodolistsResponse } from '@naf-sheets/shared'
import { decryptJson } from '../../src/crypto'
import { call, json, seedMember } from '../helpers'
import { Clock, ENCRYPTION_KEY, FakeBasecamp, MINUTE, expectLinkError, linkAccount, linkApp, linkEnv, person, redact, uniqueId } from './fake'
import type { FakePerson, FakeProject } from './fake'

const ACCOUNT = 7_300_003

function bearer(c: { headers: Record<string, string> } | undefined): string {
  return (c?.headers['authorization'] ?? '').replace(/^Bearer /, '')
}

async function accessTokenOf(userId: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT encrypted_tokens FROM user_basecamp_links WHERE user_id = ?1`).bind(userId).first<{ encrypted_tokens: string }>()
  return (await decryptJson<{ access_token: string }>(ENCRYPTION_KEY, row?.encrypted_tokens as string, `user_basecamp_links:${userId}`)).access_token
}

async function setup(role: 'admin' | 'editor' | 'viewer' = 'editor', bcAdmin = false) {
  const fake = new FakeBasecamp(ACCOUNT)
  const clock = new Clock()
  const app = linkApp(fake, clock)
  const user = await seedMember(role)
  const who = person({ admin: bcAdmin })
  const colleague = person({ name: 'سارة', email_address: 'sara@naflaw.sa' })
  fake.accountPeople = [who, colleague]
  const project: FakeProject = {
    id: uniqueId(),
    name: 'حملة اليوم الوطني',
    description: 'خطة النشر',
    todosetId: uniqueId(),
    peopleIds: [who.id, colleague.id],
    todolists: [
      { id: uniqueId(), name: 'المحتوى', completed_ratio: '2/5' },
      { id: uniqueId(), name: 'التصميم', completed_ratio: '0/0' },
    ],
  }
  fake.projects.push(project)
  expect((await linkAccount(app, fake, user, who)).status).toBe(302)
  return { fake, clock, app, user, who, colleague, project }
}

const get = (app: ReturnType<typeof linkApp>, user: { id: string }, path: string) => call(app, 'GET', path, { user, env: linkEnv(ACCOUNT) })

describe('before linking', () => {
  it('every wizard route asks the caller to link first (Arabic), without calling Basecamp', async () => {
    const fake = new FakeBasecamp(ACCOUNT)
    const app = linkApp(fake, new Clock())
    const user = await seedMember('editor')
    for (const path of ['/api/basecamp/projects', '/api/basecamp/projects/123/todolists', '/api/basecamp/projects/123/people']) {
      await expectLinkError(await get(app, user, path), 403, 'basecamp_not_linked', 'اربط حسابك')
    }
    expect(fake.calls).toHaveLength(0)
  })

  it('points the browser at the link start (B8 `link`), and only on the re-link codes', async () => {
    const fake = new FakeBasecamp(ACCOUNT)
    const app = linkApp(fake, new Clock())
    const user = await seedMember('editor')
    const body = await json<{ error: string; link?: string }>(await get(app, user, '/api/basecamp/projects'))
    expect(body).toMatchObject({ error: 'basecamp_not_linked', link: '/auth/basecamp/start' })
    const refused = await json<{ error: string; link?: string }>(
      await call(app, 'PUT', '/api/admin/people-matches/x', { user, env: linkEnv(ACCOUNT), body: {} }),
    )
    expect(refused).toMatchObject({ error: 'forbidden' })
    expect(refused.link).toBeUndefined()
  })
})

describe('GET /api/basecamp/projects', () => {
  it("lists the caller's projects with the caller's own token, never the service token", async () => {
    const { app, fake, user, project } = await setup('viewer')
    const admin = await seedMember('admin')
    expect((await linkAccount(app, fake, admin, person({ admin: true }), { service: true })).status).toBe(302)
    const serviceCalls = fake.apiCalls().length

    const res = await get(app, user, '/api/basecamp/projects')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await json<BasecampProjectsResponse>(res)).toEqual({ projects: [{ id: project.id, name: 'حملة اليوم الوطني', description: 'خطة النشر' }] })

    const calls = fake.apiCalls().slice(serviceCalls)
    expect(calls.map((c) => c.url)).toEqual([`${fake.apiBase}/projects.json`])
    expect(bearer(calls[0])).toBe(await accessTokenOf(user.id))
    expect(calls[0]?.headers['user-agent']).toBe('NAF Comms (info@naflaw.sa)')
  })

  it('answers 503 in Arabic when Basecamp is down (after its retries)', async () => {
    const { app, fake, user } = await setup()
    fake.apiFailure = 503
    await expectLinkError(await get(app, user, '/api/basecamp/projects'), 503, 'basecamp_unavailable', 'Basecamp')
  })
})

describe('GET /api/basecamp/projects/:id/todolists', () => {
  it('reads the to-do set from the project dock, then its lists', async () => {
    const { app, fake, user, project } = await setup()
    const res = await get(app, user, `/api/basecamp/projects/${project.id}/todolists`)
    expect(res.status).toBe(200)
    expect(await json<BasecampTodolistsResponse>(res)).toEqual({
      todolists: project.todolists.map((l) => ({ id: l.id, name: l.name, completedRatio: l.completed_ratio })),
    })
    expect(fake.apiCalls().slice(-2).map((c) => c.url)).toEqual([
      `${fake.apiBase}/projects/${project.id}.json`,
      `${fake.apiBase}/todosets/${project.todosetId}/todolists.json`,
    ])
  })

  it('answers 404 in Arabic when the to-dos tool is off, the project is unknown, or the id is malformed', async () => {
    const { app, fake, user, who } = await setup()
    const off: FakeProject = { id: uniqueId(), name: 'بدون مهام', description: null, todosetId: null, peopleIds: [who.id], todolists: [] }
    fake.projects.push(off)
    await expectLinkError(await get(app, user, `/api/basecamp/projects/${off.id}/todolists`), 404, 'basecamp_todoset_disabled', 'أداة المهام')
    await expectLinkError(await get(app, user, `/api/basecamp/projects/${uniqueId()}/todolists`), 404, 'basecamp_project_not_found', 'المشروع')
    const calls = fake.apiCalls().length
    await expectLinkError(await get(app, user, '/api/basecamp/projects/abc/todolists'), 404, 'basecamp_project_not_found')
    await expectLinkError(await get(app, user, '/api/basecamp/projects/0/todolists'), 404, 'basecamp_project_not_found')
    expect(fake.apiCalls()).toHaveLength(calls)
  })
})

describe('GET /api/basecamp/projects/:id/people (bc_people_cache, §9.5)', () => {
  const people = (app: ReturnType<typeof linkApp>, user: { id: string }, projectId: number) => get(app, user, `/api/basecamp/projects/${projectId}/people`)
  const peopleCalls = (fake: FakeBasecamp, projectId: number) => fake.callsTo(`${fake.apiBase}/projects/${projectId}/people.json`)

  it('fetches once, serves the cache for 10 minutes, then refreshes', async () => {
    const { app, fake, clock, user, who, colleague, project } = await setup()

    const first = await people(app, user, project.id)
    expect(first.status).toBe(200)
    const body = await json<BasecampPeopleResponse>(first)
    expect(body.people.map((p) => p.id).sort()).toEqual([who.id, colleague.id].sort())
    expect(body.refreshedAt).toBe(new Date(clock.now).toISOString())
    expect(body.people.find((p) => p.id === colleague.id)).toEqual({
      id: colleague.id,
      name: 'سارة',
      email: null,
      avatarUrl: `https://3.basecampapi.com/${ACCOUNT}/people/${colleague.id}/avatar`,
      personableType: 'User',
      client: false,
    })
    expect(peopleCalls(fake, project.id)).toHaveLength(1)
    expect(bearer(peopleCalls(fake, project.id)[0])).toBe(await accessTokenOf(user.id))

    clock.advance(10 * MINUTE)
    expect((await people(app, user, project.id)).status).toBe(200)
    expect(peopleCalls(fake, project.id)).toHaveLength(1)

    clock.advance(1 * MINUTE + 1)
    const third = await json<BasecampPeopleResponse>(await people(app, user, project.id))
    expect(peopleCalls(fake, project.id)).toHaveLength(2)
    expect(third.refreshedAt).toBe(new Date(clock.now).toISOString())
  })

  it('marks a person who left the project as removed (row kept), and stops listing them', async () => {
    const { app, fake, clock, user, colleague, project } = await setup()
    await people(app, user, project.id)
    project.peopleIds = project.peopleIds.filter((id) => id !== colleague.id)
    clock.advance(11 * MINUTE)

    const body = await json<BasecampPeopleResponse>(await people(app, user, project.id))
    expect(body.people.map((p) => p.id)).not.toContain(colleague.id)
    const row = await env.DB.prepare(`SELECT removed_at, name FROM bc_people_cache WHERE bc_project_id = ?1 AND bc_person_id = ?2`)
      .bind(project.id, colleague.id)
      .first<{ removed_at: string | null; name: string }>()
    expect(row).toEqual({ removed_at: new Date(clock.now).toISOString(), name: 'سارة' })

    // Back on the project: listed again.
    project.peopleIds.push(colleague.id)
    clock.advance(11 * MINUTE)
    expect((await json<BasecampPeopleResponse>(await people(app, user, project.id))).people.map((p) => p.id)).toContain(colleague.id)
  })

  it('stores a redacted email as null and keeps an address an admin fetched; emails go to platform admins only', async () => {
    // A Basecamp admin who is also a platform admin fills the cache with full emails.
    const { app, fake, clock, user: admin, colleague, project } = await setup('admin', true)
    const asAdmin = await json<BasecampPeopleResponse>(await people(app, admin, project.id))
    expect(asAdmin.people.find((p) => p.id === colleague.id)?.email).toBe('sara@naflaw.sa')

    // A non-admin on the same project refreshes later: Basecamp redacts, the cache keeps the address…
    const editor = await seedMember('editor')
    const editorPerson = person()
    fake.accountPeople.push(editorPerson)
    project.peopleIds.push(editorPerson.id)
    expect((await linkAccount(app, fake, editor, editorPerson)).status).toBe(302)
    clock.advance(11 * MINUTE)
    const asEditor = await json<BasecampPeopleResponse>(await people(app, editor, project.id))
    expect(peopleCalls(fake, project.id).at(-1)?.headers['authorization']).toBe(`Bearer ${await accessTokenOf(editor.id)}`)
    // …but never shows it to a non-admin.
    expect(asEditor.people.every((p) => p.email === null)).toBe(true)
    const stored = await env.DB.prepare(`SELECT email FROM bc_people_cache WHERE bc_project_id = ?1 AND bc_person_id = ?2`)
      .bind(project.id, colleague.id)
      .first<{ email: string | null }>()
    expect(stored?.email).toBe('sara@naflaw.sa')
    const redacted = await env.DB.prepare(`SELECT COUNT(*) AS n FROM bc_people_cache WHERE email LIKE '%•%'`).first<{ n: number }>()
    expect(redacted?.n).toBe(0)
    expect(redact('sara@naflaw.sa')).toContain('•')
  })

  it('does not serve the cache to someone who is not in it: refreshes with their token, and 404s without project access', async () => {
    const { app, fake, user, project } = await setup()
    expect((await people(app, user, project.id)).status).toBe(200)
    const callsAfterFirst = peopleCalls(fake, project.id).length

    // A linked member who is not on the project: the fresh cache is not handed out.
    const outsider = await seedMember('editor')
    const outsiderPerson: FakePerson = person()
    expect((await linkAccount(app, fake, outsider, outsiderPerson)).status).toBe(302)
    await expectLinkError(await people(app, outsider, project.id), 404, 'basecamp_project_not_found', 'المشروع')
    expect(peopleCalls(fake, project.id)).toHaveLength(callsAfterFirst + 1)
    expect(bearer(peopleCalls(fake, project.id).at(-1))).toBe(await accessTokenOf(outsider.id))

    // Added to the project in Basecamp: their own refresh succeeds.
    project.peopleIds.push(outsiderPerson.id)
    const res = await people(app, outsider, project.id)
    expect(res.status).toBe(200)
    expect((await json<BasecampPeopleResponse>(res)).people.map((p) => p.id)).toContain(outsiderPerson.id)
  })

  it('reports the open personable_type as given and the client flag', async () => {
    const { app, fake, user, project } = await setup()
    const robot = person({ personable_type: 'Integration' })
    const guest = person({ client: true })
    fake.accountPeople.push(robot, guest)
    project.peopleIds.push(robot.id, guest.id)
    const body = await json<BasecampPeopleResponse>(await people(app, user, project.id))
    expect(body.people.find((p) => p.id === robot.id)?.personableType).toBe('Integration')
    expect(body.people.find((p) => p.id === guest.id)?.client).toBe(true)
  })
})
