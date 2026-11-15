// Bindings of the API Worker (apps/api/wrangler.toml).

import type { BasecampRateGate } from './basecamp-rate-gate'
import type { WorkbookRoom } from './legacy-room'

/**
 * One message on `bc-inbound` (spec §9.3.2–4): a Basecamp webhook delivery,
 * stored raw. Nothing in it is trusted until the consumer checks
 * `recording.bucket.id` against `bcProjectId` and fetches the record itself.
 */
export interface BcInboundMessage {
  kind: 'basecamp_webhook'
  bcWebhookId: number
  bcProjectId: number
  receivedAt: string
  /** Request body exactly as received (not parsed). */
  body: string
}

/**
 * The station (docs/station-plan.md §4): run one link's sync. Sent on a Drive
 * notification, a Basecamp webhook of a linked project, the minute check and
 * «مزامنة الآن».
 */
export interface StationSyncMessage {
  kind: 'station_sync'
  linkId: string
  reason: 'drive' | 'basecamp' | 'manual' | 'schedule'
}

/** Everything `bc-inbound` carries. */
export type BcInboundQueueMessage = BcInboundMessage | StationSyncMessage

export interface Env {
  DB: D1Database
  /** naf-auth sessions and JWKS cache. */
  AUTH_KV: KVNamespace
  /** Settings, short-lived tokens, and the reconciliation ETag cache. */
  SETTINGS: KVNamespace
  /** The removed editor's snapshots and pictures; still copied by the daily backup, never written. */
  SNAPSHOTS: R2Bucket
  ATTACHMENTS: R2Bucket
  /**
   * Daily backups (spec §14, src/phase7/backup.ts): D1 export and copies of
   * the latest snapshots. Optional: without it the daily run is recorded as
   * skipped and nothing is written.
   */
  BACKUPS?: R2Bucket
  BC_INBOUND: Queue<BcInboundQueueMessage>
  /** The removed editor's room class, kept as a stub so its storage is not deleted (src/legacy-room.ts). */
  WORKBOOK_ROOM: DurableObjectNamespace<WorkbookRoom>
  /**
   * The platform-wide Basecamp rate limit (src/basecamp-rate-gate.ts): every
   * Basecamp request takes its slot here, 45 in any 10 s. Optional: without
   * it each isolate keeps its own window (tests).
   */
  BASECAMP_RATE_GATE?: DurableObjectNamespace<BasecampRateGate>
  AUTH_ISSUER: string
  PLATFORM_ID: string
  /**
   * Var: the public HTTPS origin Basecamp posts webhooks to, e.g.
   * `https://sheets.naflaw.sa` (spec §17-4, not decided). Without a valid
   * HTTPS origin no webhook is registered and reconciliation carries the
   * inbound sync alone.
   */
  PUBLIC_API_ORIGIN?: string
  /** Secret: `wrangler secret put AUTH_CLIENT_SECRET`. Read by naf-auth only. */
  AUTH_CLIENT_SECRET?: string
  /**
   * Station (docs/station-plan.md §5): the Google service account's JSON key,
   * whole. Secret. Each linked spreadsheet is shared with its `client_email`.
   */
  GOOGLE_SERVICE_ACCOUNT_KEY?: string
  /** Station alert emails (§6.2): Resend API key. Secret. */
  RESEND_API_KEY?: string
  /**
   * Var (dashboard): sender of alert emails, `Name <address>`, the address on
   * the domain verified in Resend. Default `NAF Sheets <sheets@naflaw.sa>`.
   */
  ALERT_EMAIL_FROM?: string
  /** Var (dashboard): comma-separated recipients; unset → every active `admin` member. */
  ALERT_EMAIL_TO?: string
}
