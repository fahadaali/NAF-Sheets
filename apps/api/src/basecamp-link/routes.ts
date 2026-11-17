// The Basecamp sync account (CLAUDE.md §2, owner decision 7): an admin
// connects the one account every station write goes out with. All of it sits
// behind the platform's auth guard.
//
//   GET  /auth/basecamp/start?service=1&next=   navigation → 302 Launchpad (admin)
//   GET  /auth/basecamp/callback                navigation → 302 `next`
//
// The editor's per-user links (/api/basecamp/*) and member matching
// (/api/admin/people-matches) were removed with the owner's approval
// (2026-11-17); their D1 rows are kept.

import { Hono } from 'hono'
import type { Context } from 'hono'
import { safeNext } from 'naf-auth'
import { ForbiddenError, NotFoundError, UnauthorizedError } from '@naf-sheets/basecamp'
import type { RawPerson } from '@naf-sheets/basecamp'
import type { AppEnv } from '../auth'
import { callerOf } from '../request'
import type { BasecampLinkDeps, BasecampLinkEnv, LinkContext } from './env'
import { linkConfig } from './env'
import { LinkFailure, basecampFailure, onLinkError } from './errors'
import { BASECAMP_PRODUCT, CALLBACK_PATH, LaunchpadError, authorizeUrl, exchangeCode, readAuthorization } from './oauth'
import { createState, consumeState } from './state'
import { basecampClient, isoAt, saveServiceToken } from './store'

function linkContext(c: Context<AppEnv>, deps: BasecampLinkDeps): LinkContext {
  const env = c.env as BasecampLinkEnv
  return { ...deps, db: env.DB, kv: env.SETTINGS, config: linkConfig(env) }
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } })
}

// ---------------------------------------------------------------------------
// /auth/basecamp — the OAuth navigations
// ---------------------------------------------------------------------------

export function basecampAuthRoutes(deps: BasecampLinkDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()
  routes.onError(onLinkError)

  routes.get('/start', async (c) => {
    const caller = callerOf(c)
    // Only the sync account is connected here, by an admin (`?service=1` is
    // what the web app sends; nothing else is offered).
    if (caller.role !== 'admin') throw new LinkFailure('service_admin_only')
    const ctx = linkContext(c, deps)
    // Validated like naf-auth's own `next`: anything unsafe becomes '/'.
    const next = safeNext(c.req.query('next'))
    const redirectUri = new URL(CALLBACK_PATH, c.req.url).toString()
    const state = await createState(ctx.kv, { userId: caller.id, next, service: true, redirectUri, createdAt: isoAt(ctx.now()) })
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
    // A state left from a personal link (removed) is not accepted.
    if (!pending || pending.userId !== caller.id || !pending.service) throw new LinkFailure('state_invalid')
    if (c.req.query('error') !== undefined) throw new LinkFailure('authorization_denied')
    const code = c.req.query('code')
    if (!code) throw new LinkFailure('launchpad_refused')
    // The role is checked again: it may have changed since /start.
    if (caller.role !== 'admin') throw new LinkFailure('service_admin_only')

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

    // The sync account must be an account admin or owner (Appendix A-7).
    // OPEN: that /my/profile.json carries `admin`/`owner` is from people.md's
    // person example; confirm at the live test (OPEN_QUESTIONS.md "Basecamp link" B19).
    if (person.admin !== true && person.owner !== true) throw new LinkFailure('service_not_admin')
    await saveServiceToken(ctx, caller.id, linked, withExpiry, at)
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
