// Running the station: one sync at a time per link, the triggers that start
// a run (Drive notification, Basecamp webhook, the minute check, «مزامنة الآن»),
// Drive channel upkeep and the admin alert emails (docs/station-plan.md §4, §6.2).

import { BATCH_WINDOW_MS, composeAlertEmail, dueForEmail, resendRequest, ALERT_SENDER, type AlertRecord, type StationAlert } from '@naf-sheets/station-sheet'
import { LinkFailure, withServiceToken } from '../basecamp-link'
import type { Env } from '../env'
import { defaultSyncDeps, readClient, syncContext, type SyncDeps } from './deps'
import { ensureProjectWebhook, publicOrigin } from './basecamp-webhook'
import { GoogleClient, GoogleError, googleErrorMessage, parseServiceAccountKey, type FetchLike } from './google'
import { syncLink, type RunReport, type SheetPort } from './run'
import { recordAlerts } from './store'

/** A run holds its link this long at most; a crashed run frees it after that. */
export const LEASE_MS = 5 * 60_000
/** Drive caps a file channel at one day; renew when less than this is left. */
const CHANNEL_RENEW_BEFORE_MS = 3 * 3600_000
const CHANNEL_TTL_MS = 24 * 3600_000
/** Full pass of every link (catches Basecamp changes no webhook announces). */
export const FULL_PASS_MS = 15 * 60_000

export interface StationDeps extends SyncDeps {
  /** Tests inject a fake sheet; production builds a GoogleClient from the secret. */
  google?: SheetPort & Partial<Pick<GoogleClient, 'watch' | 'stopChannel'>>
}

export function googleFor(env: Env, deps: { fetch: FetchLike; now: () => number }): GoogleClient {
  return new GoogleClient({ key: parseServiceAccountKey(env.GOOGLE_SERVICE_ACCOUNT_KEY), fetch: deps.fetch, now: deps.now })
}

/**
 * Takes the link's lease, runs, and runs again while someone asked for it
 * during the run (`resync`), so bursts of notifications coalesce into few runs.
 * Returns null when another run holds the link (it will run again for us).
 */
export async function runStation(env: Env, linkId: string, deps: StationDeps = defaultSyncDeps()): Promise<RunReport | null> {
  const db = env.DB
  const iso = (ms: number): string => new Date(ms).toISOString()
  const taken = await db
    .prepare(`UPDATE station_links SET lock_until = ?2, resync = 0 WHERE id = ?1 AND (lock_until IS NULL OR lock_until < ?3)`)
    .bind(linkId, iso(deps.now() + LEASE_MS), iso(deps.now()))
    .run()
  if (taken.meta.changes !== 1) {
    await db.prepare(`UPDATE station_links SET resync = 1 WHERE id = ?1`).bind(linkId).run()
    return null
  }
  let report: RunReport | null = null
  try {
    for (let round = 0; round < 5; round++) {
      report = await runOnce(env, linkId, deps)
      const again = await db
        .prepare(`UPDATE station_links SET resync = 0, lock_until = CASE WHEN resync = 1 THEN ?2 ELSE NULL END WHERE id = ?1 RETURNING lock_until`)
        .bind(linkId, iso(deps.now() + LEASE_MS))
        .first<{ lock_until: string | null }>()
      if (!again?.lock_until) return report
    }
  } finally {
    await db.prepare(`UPDATE station_links SET lock_until = NULL WHERE id = ?1 AND lock_until IS NOT NULL AND resync = 0`).bind(linkId).run()
  }
  return report
}

async function runOnce(env: Env, linkId: string, deps: StationDeps): Promise<RunReport> {
  let google: SheetPort
  try {
    google = deps.google ?? googleFor(env, deps)
  } catch (error) {
    if (!(error instanceof GoogleError)) throw error
    const link = await env.DB.prepare(`SELECT title FROM station_links WHERE id = ?1`).bind(linkId).first<{ title: string }>()
    const alert: StationAlert = { kind: 'link_stopped', linkId, linkTitle: link?.title ?? '', reason: googleErrorMessage(error.code) }
    await recordAlerts(env.DB, linkId, [alert], new Set(), new Date(deps.now()).toISOString(), { complete: false })
    return { status: 'stopped', toBasecamp: 0, toSheet: 0, deleted: 0, alerts: [alert] }
  }
  const ctx = syncContext(env, deps)
  try {
    return await withServiceToken(ctx, (token) => syncLink(linkId, { db: env.DB, google, basecamp: readClient(ctx), token, now: deps.now }))
  } catch (error) {
    // A run that stops half-way must not leave the admin with stale problems
    // and no word: say so on the link (the queue retries the run).
    const link = await env.DB.prepare(`SELECT title FROM station_links WHERE id = ?1`).bind(linkId).first<{ title: string }>()
    const name = error instanceof Error ? error.name : 'Error'
    const reason = basecampReason(error) ?? `توقفت المزامنة قبل أن تكتمل (${name}). ستُعاد المحاولة تلقائياً؛ وإن تكرر ذلك فأبلغ مسؤول المنصة.`
    const at = new Date(deps.now()).toISOString()
    // Like any problem: a crash that comes back after a good run is emailed again.
    await recordAlerts(env.DB, linkId, [{ kind: 'link_stopped', linkId, linkTitle: link?.title ?? '', reason }], new Set(), at, { complete: false })
    await env.DB.prepare(`UPDATE station_links SET last_error = ?2, updated_at = ?3 WHERE id = ?1`).bind(linkId, reason, at).run()
    throw error
  }
}

/** Arabic reason for the Basecamp failures an admin can act on. */
function basecampReason(error: unknown): string | null {
  if (error instanceof LinkFailure && error.key === 'service_not_linked') return 'حساب المزامنة في Basecamp غير مربوط. اضغط «اربط حساب المزامنة» في صفحة الإعدادات.'
  if (error instanceof LinkFailure) return 'تعذّر استخدام حساب المزامنة في Basecamp. أعد ربطه من صفحة الإعدادات.'
  return null
}

/** Queues a run (Drive notification, Basecamp webhook, «مزامنة الآن»). */
export async function requestRun(env: Env, linkId: string, reason: 'drive' | 'basecamp' | 'manual' | 'schedule'): Promise<void> {
  await env.BC_INBOUND.send({ kind: 'station_sync', linkId, reason })
}

/**
 * The minute cron: runs links whose file changed (Drive `modifiedTime`, the
 * fallback when a notification is lost) or whose full pass is due, renews
 * Drive channels and Basecamp webhooks, and sends the alert emails that are due.
 */
export async function stationMinute(env: Env, deps: StationDeps = defaultSyncDeps()): Promise<void> {
  const now = deps.now()
  const links = await env.DB.prepare(`SELECT id, spreadsheet_id, bc_project_id, last_modified, last_sync_at FROM station_links WHERE state = 'active'`).all<{
    id: string
    spreadsheet_id: string
    bc_project_id: number
    last_modified: string | null
    last_sync_at: string | null
  }>()
  let google: (SheetPort & Partial<Pick<GoogleClient, 'watch' | 'stopChannel'>>) | null = null
  try {
    google = deps.google ?? googleFor(env, deps)
  } catch {
    google = null
  }
  for (const link of links.results) {
    try {
      const full = link.last_sync_at === null || now - Date.parse(link.last_sync_at) >= FULL_PASS_MS
      let changed = false
      if (!full && google) changed = (await google.modifiedTime(link.spreadsheet_id)) !== link.last_modified
      if (full || changed || google === null) await requestRun(env, link.id, 'schedule')
      if (full) {
        await ensureChannel(env, link.id, link.spreadsheet_id, google, now)
        await ensureProjectWebhook(env, { workbookId: `station:${link.id}`, bcProjectId: link.bc_project_id }, deps)
      }
    } catch (error) {
      console.warn(`station: minute check of a link failed (${error instanceof Error ? error.name : 'unknown'})`)
    }
  }
  await sendDueAlerts(env, deps)
}

/** Opens (or renews) the Drive push channel of a link. */
export async function ensureChannel(
  env: Env,
  linkId: string,
  fileId: string,
  google: Partial<Pick<GoogleClient, 'watch' | 'stopChannel'>> | null,
  now: number,
): Promise<void> {
  const origin = publicOrigin(env)
  if (!origin || !google?.watch) return
  const current = await env.DB.prepare(`SELECT channel_id, resource_id, expires_at FROM station_channels WHERE link_id = ?1`).bind(linkId).first<{
    channel_id: string
    resource_id: string
    expires_at: string
  }>()
  if (current && Date.parse(current.expires_at) - now > CHANNEL_RENEW_BEFORE_MS) return
  const secret = await env.DB.prepare(`SELECT notify_secret FROM station_links WHERE id = ?1`).bind(linkId).first<{ notify_secret: string }>()
  if (!secret) return
  const channel = await google.watch(fileId, { id: crypto.randomUUID(), address: `${origin}/webhooks/google/${secret.notify_secret}`, token: linkId, ttlMs: CHANNEL_TTL_MS })
  await env.DB.prepare(
    `INSERT INTO station_channels (link_id, channel_id, resource_id, expires_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (link_id) DO UPDATE SET channel_id = excluded.channel_id, resource_id = excluded.resource_id, expires_at = excluded.expires_at`,
  )
    .bind(linkId, channel.id, channel.resourceId, new Date(channel.expiration).toISOString())
    .run()
  if (current && google.stopChannel) {
    await google.stopChannel({ id: current.channel_id, resourceId: current.resource_id }).catch(() => undefined)
  }
}

/** Who gets the alert emails: ALERT_EMAIL_TO, else every active admin with an email. */
async function recipients(env: Env): Promise<string[]> {
  const configured = (env.ALERT_EMAIL_TO ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.includes('@'))
  if (configured.length > 0) return configured
  const admins = await env.DB.prepare(`SELECT email FROM members WHERE role = 'admin' AND is_active = 1 AND email IS NOT NULL`).all<{ email: string }>()
  return admins.results.map((a) => a.email).filter((e) => e.includes('@'))
}

/** Emails the open problems whose batch window has passed (§6.2). */
export async function sendDueAlerts(env: Env, deps: { fetch: FetchLike; now: () => number }): Promise<number> {
  if (!env.RESEND_API_KEY) return 0
  const open = await env.DB.prepare(`SELECT key, alert_json, first_seen, emailed_at, resolved_at FROM station_alerts WHERE resolved_at IS NULL AND emailed_at IS NULL`).all<{
    key: string
    alert_json: string
    first_seen: string
    emailed_at: string | null
    resolved_at: string | null
  }>()
  const records: AlertRecord[] = open.results.map((r) => ({
    key: r.key,
    alert: JSON.parse(r.alert_json) as StationAlert,
    firstSeen: r.first_seen,
    emailedAt: r.emailed_at,
    resolvedAt: r.resolved_at,
  }))
  const due = dueForEmail(records, new Date(deps.now()).toISOString())
  if (due.length === 0) return 0
  const to = await recipients(env)
  const origin = publicOrigin(env)
  if (to.length === 0 || !origin) return 0
  const email = composeAlertEmail(
    due.map((r) => r.alert),
    { origin },
  )
  const keys = due.map((r) => r.key).sort()
  // The same problems opened at the same time are one email, whatever retries;
  // a problem that came back (a new first_seen) is a new email.
  const occurrences = due.map((r) => `${r.key}@${r.firstSeen}`).sort()
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(occurrences.join('\n'))))
  const idempotencyKey = [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')
  const request = resendRequest(email, { apiKey: env.RESEND_API_KEY, to, idempotencyKey, from: env.ALERT_EMAIL_FROM?.trim() || ALERT_SENDER })
  const res = await deps.fetch(request.url, { method: 'POST', headers: request.headers, body: await request.text() })
  if (!res.ok) {
    console.error(`station: alert email refused by Resend (${res.status})`)
    return 0
  }
  const at = new Date(deps.now()).toISOString()
  await env.DB.batch(keys.map((k) => env.DB.prepare(`UPDATE station_alerts SET emailed_at = ?2 WHERE key = ?1`).bind(k, at)))
  return due.length
}

export { BATCH_WINDOW_MS }
