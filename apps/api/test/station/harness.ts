// Shared setup of the station tests: the fake Basecamp, an env whose queue is
// a recorder, and the sync account's token stored exactly as
// src/basecamp-link stores it. Nothing remote is called.

import { env } from 'cloudflare:workers'
import { encryptJson } from '../../src/crypto'
import type { BcInboundQueueMessage, Env } from '../../src/env'
import type { SyncDeps } from '../../src/station/deps'
import { FakeBasecamp, uniqueId } from '../support/fake-basecamp'
import type { FakePerson } from '../support/fake-basecamp'

export const ENCRYPTION_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
export const ORIGIN = 'https://sheets.naflaw.test'
const FAR = new Date(Date.now() + 365 * 24 * 3600_000).toISOString()

export class RecordingQueue<T> {
  sent: Array<{ body: T; delaySeconds?: number }> = []
  async send(body: T, options?: { delaySeconds?: number }): Promise<void> {
    this.sent.push({ body: structuredClone(body), delaySeconds: options?.delaySeconds })
  }
  async sendBatch(messages: Iterable<{ body: T; delaySeconds?: number }>): Promise<void> {
    for (const m of messages) this.sent.push({ body: structuredClone(m.body), delaySeconds: m.delaySeconds })
  }
  take(): Array<{ body: T; delaySeconds?: number }> {
    const out = this.sent
    this.sent = []
    return out
  }
}

export interface Harness {
  fake: FakeBasecamp
  env: Env
  deps: SyncDeps
  inbound: RecordingQueue<BcInboundQueueMessage>
}

export function harness(): Harness {
  const fake = new FakeBasecamp(uniqueId())
  const inbound = new RecordingQueue<BcInboundQueueMessage>()
  const stationEnv = {
    ...env,
    BASECAMP_CLIENT_ID: 'naf-sheets-test-client',
    BASECAMP_CLIENT_SECRET: 'test-client-secret',
    TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
    BASECAMP_ACCOUNT_ID: String(fake.accountId),
    PUBLIC_API_ORIGIN: ORIGIN,
    BC_INBOUND: inbound as unknown as Queue<BcInboundQueueMessage>,
  } as Env
  const deps: SyncDeps = { fetch: fake.fetch, now: () => Date.now(), limiter: { acquire: async () => {} }, sleep: async () => {} }
  return { fake, env: stationEnv, deps, inbound }
}

/** The sync account (an admin's Basecamp account, spec §3 «رمز الخدمة»). Returns the access token. */
export async function linkService(h: Harness, adminId: string, person: FakePerson): Promise<string> {
  const token = h.fake.token(person.id)
  const id = crypto.randomUUID()
  const sealed = await encryptJson(ENCRYPTION_KEY, { access_token: token, refresh_token: 'rt-unused' }, `integrations:${id}`)
  const at = new Date().toISOString()
  await env.DB.prepare(`DELETE FROM integrations WHERE provider = 'basecamp'`).run()
  await env.DB.prepare(
    `INSERT INTO integrations (id, provider, account_id, encrypted_tokens, expires_at, created_by, created_at, status, bc_person_id, updated_at, updated_by)
     VALUES (?1, 'basecamp', ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?6, ?5)`,
  )
    .bind(id, String(h.fake.accountId), sealed, FAR, adminId, at, person.id)
    .run()
  return token
}
