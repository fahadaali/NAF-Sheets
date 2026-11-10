// Routes of the Basecamp link (contract: packages/shared/src/api-integrations.ts,
// "Basecamp" section). All of them sit behind the platform's auth guard.
//
//   GET  /auth/basecamp/start?next=[&service=1]   navigation → 302 Launchpad
//   GET  /auth/basecamp/callback                  navigation → 302 `next`
//   GET  /api/basecamp/link                       BasecampLinkResponse
//   POST /api/basecamp/link/revoke                RevokeBasecampLinkResponse
//   GET  /api/basecamp/projects                   BasecampProjectsResponse      (caller's token)
//   GET  /api/basecamp/projects/:id/todolists     BasecampTodolistsResponse     (caller's token)
//   GET  /api/basecamp/projects/:id/people        BasecampPeopleResponse        (caller's token, cache §9.5)
//   GET  /api/admin/people-matches                PeopleMatchesResponse         (admin; service token)
//   PUT  /api/admin/people-matches/:userId        one match entry               (admin; audited)
//
// Roles: everyone signed in — viewers included — may link, revoke and read
// their own Basecamp data: linking is not editing a workbook, and every
// Basecamp read uses the caller's own token, so it shows nothing their
// Basecamp account cannot already see. The service token and the matching
// screen are for platform admins only.

import { Hono } from 'hono'
import type { Context } from 'hono'
import { safeNext } from 'naf-auth'
import { ForbiddenError, NotFoundError, UnauthorizedError, findTodosetId } from '@naf-sheets/basecamp'
import type { RawPerson } from '@naf-sheets/basecamp'
import type {
  BasecampLinkResponse,
  BasecampProjectsResponse,
  BasecampTodolistsResponse,
  PeopleMatchesResponse,
  RevokeBasecampLinkResponse,
} from '@naf-sheets/shared'
import type { AppEnv } from '../auth'
import { callerOf, isPlainObject, readJson } from '../request'
import type { BasecampLinkDeps, BasecampLinkEnv, LinkContext } from './env'
import { linkConfig } from './env'
import { LinkFailure, onLinkError } from './errors'
import { BASECAMP_PRODUCT, CALLBACK_PATH, LaunchpadError, authorizeUrl, exchangeCode, readAuthorization } from './oauth'
import { basecampFailure, peopleMatches, projectError, projectPeople, setManualMatch } from './people'
import { createState, consumeState } from './state'
import { basecampClient, getUserLinkRow, isoAt, revokeUserLink, saveServiceToken, saveUserLink, withUserToken } from './store'

function linkContext(c: Context<AppEnv>, deps: BasecampLinkDeps): LinkContext {
  const env = c.env as BasecampLinkEnv
  return { ...deps, db: env.DB, kv: env.SETTINGS, config: linkConfig(env) }
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } })
}

/** A positive integer path segment, or 404 (`project_not_found`). */
function projectIdParam(c: Context<AppEnv>): number {
  const text = c.req.param('projectId') ?? ''
  const id = /^[1-9]\d{0,15}$/.test(text) ? Number(text) : Number.NaN
  if (!Number.isSafeInteger(id)) throw new LinkFailure('project_not_found')
  return id
}

// ---------------------------------------------------------------------------
// /auth/basecamp — the OAuth navigations
// ---------------------------------------------------------------------------

export function basecampAuthRoutes(deps: BasecampLinkDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()
  routes.onError(onLinkError)

  routes.get('/start', async (c) => {
    const caller = callerOf(c)
    // `?service=1`: an admin connects the service token (spec §3) through the
    // same flow. Only the exact value '1' asks for it.
    const service = c.req.query('service') === '1'
    if (service && caller.role !== 'admin') throw new LinkFailure('service_admin_only')
    const ctx = linkContext(c, deps)
    // Validated like naf-auth's own `next`: anything unsafe becomes '/'.
    const next = safeNext(c.req.query('next'))
    const redirectUri = new URL(CALLBACK_PATH, c.req.url).toString()
    const state = await createState(ctx.kv, { userId: caller.id, next, service, redirectUri, createdAt: isoAt(ctx.now()) })
    return redirect(authorizeUrl(ctx.config.clientId, redirectUri, state))
  })

  // OPEN: failures answer with an ApiError JSON body (Arabic message) even
  // though this is a page navigation; whether to send the browser back to
  // `next` with a reason instead is for the web app to decide
  // (apps/api/OPEN_QUESTIONS.md "Basecamp link" B9).
  routes.get('/callback', async (c) => {
    const caller = callerOf(c)
    const ctx = linkContext(c, deps)

    // The state is consumed whatever happens next: one attempt per state.
    const pending = await consumeState(ctx.kv, c.req.query('state') ?? '')
    if (!pending || pending.userId !== caller.id) throw new LinkFailure('state_invalid')
    if (c.req.query('error') !== undefined) throw new LinkFailure('authorization_denied')
    const code = c.req.query('code')
    if (!code) throw new LinkFailure('launchpad_refused')
    // The role is checked again: it may have changed since /start.
    if (pending.service && caller.role !== 'admin') throw new LinkFailure('service_admin_only')

    const tokens = await launchpad(() => exchangeCode(ctx, ctx.config, code, pending.redirectUri))
    const authorization = await launchpad(() => readAuthorization(ctx, tokens.accessToken))
    if (!authorization.accounts.some((a) => a.product === BASECAMP_PRODUCT && a.id === ctx.config.accountId)) {
      throw new LinkFailure('account_missing')
    }

    // Who the token belongs to inside NAF's account (not Launchpad's
    // `identity`, whose email Launchpad does not verify).
    const person = await profile(ctx, tokens.accessToken)
    const linked = { bcPersonId: person.id, name: typeof person.name === 'string' ? person.name : '' }
    const withExpiry = { ...tokens, expiresAt: tokens.expiresAt ?? authorization.expiresAt }
    const at = isoAt(ctx.now())

    if (pending.service) {
      // Matching by email needs an account admin or owner (Appendix A-7).
      // OPEN: that /my/profile.json carries `admin`/`owner` is from people.md's
      // person example; confirm at the live test (OPEN_QUESTIONS.md "Basecamp link" B19).
      if (person.admin !== true && person.owner !== true) throw new LinkFailure('service_not_admin')
      await saveServiceToken(ctx, caller.id, linked, withExpiry, at)
    } else {
      await saveUserLink(ctx, caller.id, linked, withExpiry, at)
    }
    return redirect(safeNext(pending.next))
  })

  return routes
}

/** Launchpad failures as the user should read them; logged by kind, status and OAuth code only. */
async function launchpad<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (!(error instanceof LaunchpadError)) throw error
    console.warn(`basecamp-link: Launchpad ${error.kind} (${error.status ?? 'no response'}${error.oauthError ? `, ${error.oauthError}` : ''})`)
    if (error.kind === 'client_rejected') throw new LinkFailure('not_configured')
    if (error.kind === 'refused') throw new LinkFailure('launchpad_refused')
    throw new LinkFailure('basecamp_unavailable')
  }
}

/** GET /my/profile.json with the new token: the person's id in NAF's account. */
async function profile(ctx: LinkContext, accessToken: string): Promise<RawPerson> {
  let person: RawPerson
  try {
    person = await basecampClient(ctx).people.me(accessToken)
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ForbiddenError) throw new LinkFailure('account_missing')
    if (error instanceof UnauthorizedError) throw new LinkFailure('launchpad_refused')
    throw basecampFailure(error)
  }
  if (typeof person.id !== 'number' || !Number.isSafeInteger(person.id) || person.id <= 0) throw new LinkFailure('basecamp_unavailable')
  // An open set; only a human account may stand for a member (Appendix A-2).
  if (person.personable_type !== undefined && person.personable_type !== 'User') throw new LinkFailure('not_a_user')
  return person
}

// ---------------------------------------------------------------------------
// /api/basecamp — the caller's own link and Basecamp data
// ---------------------------------------------------------------------------

export function basecampApiRoutes(deps: BasecampLinkDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()
  routes.onError(onLinkError)

  // Works without the Launchpad configuration: it only reads the row.
  routes.get('/link', async (c) => {
    const caller = callerOf(c)
    const row = await getUserLinkRow((c.env as BasecampLinkEnv).DB, caller.id)
    if (!row) return c.json<BasecampLinkResponse>({ state: 'unlinked', bcPersonId: null, bcAccountId: null, name: null })
    return c.json<BasecampLinkResponse>({
      state: row.status,
      bcPersonId: row.bc_person_id,
      bcAccountId: row.bc_account_id,
      name: row.bc_person_name,
    })
  })

  routes.post('/link/revoke', async (c) => {
    const caller = callerOf(c)
    const outcome = await revokeUserLink((c.env as BasecampLinkEnv).DB, caller.id, isoAt(deps.now()))
    if (outcome === 'none') throw new LinkFailure('not_linked')
    return c.json<RevokeBasecampLinkResponse>({ state: 'revoked' })
  })

  routes.get('/projects', async (c) => {
    const caller = callerOf(c)
    const ctx = linkContext(c, deps)
    const client = basecampClient(ctx)
    const projects = await withUserToken(ctx, caller.id, async (token) => {
      try {
        return await client.projects.list(token).all()
      } catch (error) {
        throw basecampFailure(error)
      }
    })
    return c.json<BasecampProjectsResponse>({
      projects: projects.map((p) => ({ id: p.id, name: p.name, description: typeof p.description === 'string' ? p.description : null })),
    })
  })

  routes.get('/projects/:projectId/todolists', async (c) => {
    const caller = callerOf(c)
    const projectId = projectIdParam(c)
    const ctx = linkContext(c, deps)
    const client = basecampClient(ctx)
    // The project's lists live in its to-do set, found in the project's dock (Appendix A-2/A-3).
    const lists = await withUserToken(ctx, caller.id, async (token) => {
      let todosetId: number | null
      try {
        todosetId = findTodosetId(await client.projects.get(token, projectId))
      } catch (error) {
        throw projectError(error)
      }
      if (todosetId === null) throw new LinkFailure('todoset_disabled')
      try {
        return await client.todolists.list(token, todosetId).all()
      } catch (error) {
        throw projectError(error)
      }
    })
    return c.json<BasecampTodolistsResponse>({
      todolists: lists.map((l) => ({
        id: l.id,
        name: typeof l.name === 'string' ? l.name : l.title,
        completedRatio: typeof l.completed_ratio === 'string' ? l.completed_ratio : null,
      })),
    })
  })

  routes.get('/projects/:projectId/people', async (c) => {
    const caller = callerOf(c)
    const projectId = projectIdParam(c)
    const ctx = linkContext(c, deps)
    return c.json(await projectPeople(ctx, caller, projectId))
  })

  return routes
}

// ---------------------------------------------------------------------------
// /api/admin/people-matches — admins only
// ---------------------------------------------------------------------------

function requireAdmin(c: Context<AppEnv>): string {
  const caller = callerOf(c)
  if (caller.role !== 'admin') throw new LinkFailure('admin_only')
  return caller.id
}

export function peopleMatchRoutes(deps: BasecampLinkDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()
  routes.onError(onLinkError)

  routes.get('/', async (c) => {
    requireAdmin(c)
    const ctx = linkContext(c, deps)
    return c.json<PeopleMatchesResponse>(await peopleMatches(ctx))
  })

  // OPEN: the contract gives no response type; the member's match entry is returned (B12).
  routes.put('/:userId', async (c) => {
    const adminId = requireAdmin(c)
    const userId = c.req.param('userId')
    const body = await readJson(c)
    if (!isPlainObject(body) || !('bcPersonId' in body)) throw new LinkFailure('invalid_match')
    const value = body['bcPersonId']
    const bcPersonId = value === null ? null : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
    if (bcPersonId === undefined) throw new LinkFailure('invalid_match')
    if (!userId || userId.length > 255) throw new LinkFailure('member_not_found')
    const ctx = linkContext(c, deps)
    return c.json(await setManualMatch(ctx, adminId, userId, bcPersonId))
  })

  return routes
}
