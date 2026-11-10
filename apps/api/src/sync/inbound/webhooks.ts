// The project's webhook (spec §9.3.1–3): created with the service token on
// the five types, with a random secret of 48 URL-safe characters in the
// payload path. Reconciliation checks it every run: Basecamp disables a
// webhook after 10 failed deliveries, so an inactive one is re-enabled and a
// missing one (404) recreated. Nothing is deleted in Basecamp.

import { LimitReachedError, NAF_WEBHOOK_TYPES, NotFoundError } from '@naf-sheets/basecamp'
import type { BasecampClient } from '@naf-sheets/basecamp'
import { LinkFailure, withServiceToken } from '../../basecamp-link'
import type { LinkContext } from '../../basecamp-link'
import type { Env } from '../../env'
import { defaultSyncDeps, readClient, syncContext } from '../deps'
import type { SyncDeps } from '../deps'

export type WebhookStatus =
  | { status: 'active'; bcWebhookId: number }
  /** Not registered now; reconciliation retries every 15 minutes. */
  | { status: 'pending'; reason: 'no_public_origin' | 'not_configured' | 'service_not_linked' | 'limit_reached' | 'unavailable' }

const SECRET_LENGTH = 48

export function webhookSecret(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const bytes = crypto.getRandomValues(new Uint8Array(SECRET_LENGTH))
  let out = ''
  for (const b of bytes) out += alphabet[b % 64]
  return out
}

/**
 * `PUBLIC_API_ORIGIN` when it is an HTTPS origin; Basecamp refuses anything else (Appendix A-6).
 * OPEN: the platform's origin is spec §17-4, not decided (S10).
 */
export function publicOrigin(env: Env): string | null {
  const raw = env.PUBLIC_API_ORIGIN?.trim() ?? ''
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search !== '' || url.hash !== '') return null
    return url.origin
  } catch {
    return null
  }
}

export function payloadUrl(origin: string, secret: string): string {
  return `${origin}/webhooks/basecamp/${secret}`
}

interface HookRow {
  bc_webhook_id: number
  secret: string
  active: number
}

export async function ensureProjectWebhook(
  env: Env,
  input: { workbookId: string; bcProjectId: number },
  deps: SyncDeps = defaultSyncDeps(),
  given?: LinkContext,
): Promise<WebhookStatus> {
  const origin = publicOrigin(env)
  if (origin === null) {
    console.warn('sync: PUBLIC_API_ORIGIN is not an HTTPS origin; no webhook registered')
    return { status: 'pending', reason: 'no_public_origin' }
  }
  let ctx: LinkContext
  try {
    ctx = given ?? syncContext(env, deps)
  } catch (error) {
    if (error instanceof LinkFailure) return { status: 'pending', reason: 'not_configured' }
    throw error
  }
  try {
    return await withServiceToken(ctx, (token) => ensureWith(env, readClient(ctx), token, origin, input, deps))
  } catch (error) {
    if (error instanceof LinkFailure) return { status: 'pending', reason: error.key === 'service_not_linked' ? 'service_not_linked' : 'unavailable' }
    if (error instanceof LimitReachedError) {
      console.error(`sync: Basecamp webhook limit reached (507) for project ${input.bcProjectId}`)
      return { status: 'pending', reason: 'limit_reached' }
    }
    console.warn(`sync: webhook check failed (${error instanceof Error ? error.name : 'unknown'})`)
    return { status: 'pending', reason: 'unavailable' }
  }
}

async function ensureWith(
  env: Env,
  client: BasecampClient,
  token: string,
  origin: string,
  input: { workbookId: string; bcProjectId: number },
  deps: SyncDeps,
): Promise<WebhookStatus> {
  const db = env.DB
  const at = new Date(deps.now()).toISOString()
  const { results } = await db
    .prepare(`SELECT bc_webhook_id, secret, active FROM bc_webhooks WHERE bc_project_id = ?1 AND replaced_at IS NULL ORDER BY created_at DESC`)
    .bind(input.bcProjectId)
    .all<HookRow>()
  for (const row of results) {
    const url = payloadUrl(origin, row.secret)
    try {
      const hook = await client.webhooks.get(token, row.bc_webhook_id)
      if (hook.active !== true || hook.payload_url !== url) {
        await client.webhooks.update(token, row.bc_webhook_id, { payloadUrl: url, types: NAF_WEBHOOK_TYPES, active: true })
        await db
          .prepare(
            `INSERT INTO audit_log (at, actor_id, action, entity_type, entity_id, workbook_id, details_json)
             VALUES (?1, NULL, 'basecamp.webhook.reactivate', 'bc_webhook', ?2, ?3, ?4)`,
          )
          .bind(at, String(row.bc_webhook_id), input.workbookId, JSON.stringify({ wasActive: hook.active === true }))
          .run()
      }
      await db.prepare(`UPDATE bc_webhooks SET active = 1, checked_at = ?2 WHERE bc_webhook_id = ?1`).bind(row.bc_webhook_id, at).run()
      return { status: 'active', bcWebhookId: row.bc_webhook_id }
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error
      // Basecamp no longer has it: kept for the record, replaced below.
      await db.prepare(`UPDATE bc_webhooks SET active = 0, replaced_at = ?2, checked_at = ?2 WHERE bc_webhook_id = ?1`).bind(row.bc_webhook_id, at).run()
    }
  }
  const secret = webhookSecret()
  const hook = await client.webhooks.create(token, input.bcProjectId, { payloadUrl: payloadUrl(origin, secret), types: NAF_WEBHOOK_TYPES })
  await db.batch([
    db
      .prepare(
        `INSERT INTO bc_webhooks (bc_webhook_id, bc_project_id, secret, types_json, created_at, active, checked_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?5)`,
      )
      .bind(hook.id, input.bcProjectId, secret, JSON.stringify(NAF_WEBHOOK_TYPES), at, hook.active === false ? 0 : 1),
    db
      .prepare(
        `INSERT INTO audit_log (at, actor_id, action, entity_type, entity_id, workbook_id, details_json)
         VALUES (?1, NULL, 'basecamp.webhook.create', 'bc_webhook', ?2, ?3, ?4)`,
      )
      .bind(at, String(hook.id), input.workbookId, JSON.stringify({ bcProjectId: input.bcProjectId, types: NAF_WEBHOOK_TYPES })),
  ])
  return { status: 'active', bcWebhookId: hook.id }
}
