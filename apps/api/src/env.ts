// Bindings of the API Worker (apps/api/wrangler.toml).

import type { BasecampRateGate } from './basecamp-rate-gate'
import type { WorkbookRoom } from './room'

/**
 * One message on `bc-outbound` (spec §9.2.2–3): a task changed in the
 * platform and must be written to Basecamp with the token of the user who
 * made the change. The consumer rebuilds the full state from D1 + the
 * snapshot, so the message carries identities only, and a duplicate message
 * is a harmless no-op.
 */
export interface BcOutboundMessage {
  kind: 'task_changed'
  workbookId: string
  taskUid: string
  /** members.user_id of the person whose token must be used (§3). */
  actorUserId: string
  enqueuedAt: string
}

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
 * «مزامنة الآن» (§9.4): reconcile one workbook now, ignoring stored ETags.
 * Sent by POST /api/workbooks/:id/sync-now; processed on `bc-inbound`
 * because it only reads Basecamp (service token) and writes the sheet.
 */
export interface BcReconcileMessage {
  kind: 'reconcile'
  workbookId: string
  /** members.user_id of the person who asked. */
  requestedBy: string
  enqueuedAt: string
}

/** Everything `bc-inbound` carries. */
export type BcInboundQueueMessage = BcInboundMessage | BcReconcileMessage

export interface Env {
  DB: D1Database
  /** naf-auth sessions and JWKS cache. */
  AUTH_KV: KVNamespace
  /** Settings, short-lived tokens, and the reconciliation ETag cache. */
  SETTINGS: KVNamespace
  /** Univer snapshots: workbooks/{id}/snapshots/{version}.json */
  SNAPSHOTS: R2Bucket
  ATTACHMENTS: R2Bucket
  /**
   * Daily backups (spec §14, src/phase7/backup.ts): D1 export and copies of
   * the latest snapshots. Optional: without it the daily run is recorded as
   * skipped and nothing is written.
   */
  BACKUPS?: R2Bucket
  BC_OUTBOUND: Queue<BcOutboundMessage>
  BC_INBOUND: Queue<BcInboundQueueMessage>
  /**
   * Producer on `bc-outbound-dlq`: a message given up after its last attempt
   * is sent here explicitly (and recorded in D1 `sync_dead_letters`), §9.2.8.
   * Optional so a missing binding is reported, not assumed.
   */
  BC_OUTBOUND_DLQ?: Queue<BcOutboundMessage>
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
}
