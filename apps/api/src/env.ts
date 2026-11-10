// Bindings of the API Worker (apps/api/wrangler.toml).

import type { WorkbookRoom } from './room'

/**
 * One message on `bc-outbound` (spec §9.2.2–3): a task changed in the
 * platform and must be written to Basecamp with the token of the user who
 * made the change. The consumer rebuilds the full state from D1 + the
 * snapshot, so the message carries identities only.
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

export interface Env {
  DB: D1Database
  /** naf-auth sessions and JWKS cache. */
  AUTH_KV: KVNamespace
  /** Settings and short-lived tokens. */
  SETTINGS: KVNamespace
  /** Univer snapshots: workbooks/{id}/snapshots/{version}.json */
  SNAPSHOTS: R2Bucket
  ATTACHMENTS: R2Bucket
  BC_OUTBOUND: Queue<BcOutboundMessage>
  BC_INBOUND: Queue<BcInboundMessage>
  WORKBOOK_ROOM: DurableObjectNamespace<WorkbookRoom>
  AUTH_ISSUER: string
  PLATFORM_ID: string
  /** Secret: `wrangler secret put AUTH_CLIENT_SECRET`. Read by naf-auth only. */
  AUTH_CLIENT_SECRET?: string
}
