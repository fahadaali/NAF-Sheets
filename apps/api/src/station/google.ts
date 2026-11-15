// Google access for the station (docs/station-plan.md §4, §5), as the service
// account whose JSON key is the secret GOOGLE_SERVICE_ACCOUNT_KEY. Every linked
// spreadsheet is shared with its `client_email` as Editor.
//
// - Token: a JWT signed with the key (RS256, WebCrypto) exchanged at the
//   token endpoint (OAuth 2.0 JWT bearer grant); cached until a minute before
//   it expires.
// - Sheets: values of the linked tabs (unformatted, dates as serial numbers),
//   row identities as developer metadata (they move with the row), cell writes.
// - Drive: the file's modifiedTime and push-notification channels.
//
// Nothing here decides anything about sync: it only reads and writes.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export const SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.readonly'] as const
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets'
const DRIVE = 'https://www.googleapis.com/drive/v3/files'

/** Developer-metadata key holding a row's task uid (docs/station-plan.md §3). */
export const ROW_UID_KEY = 'naf_task_uid'

export interface ServiceAccountKey {
  clientEmail: string
  privateKeyPem: string
  tokenUri: string
}

export type GoogleErrorCode =
  | 'key_missing'
  | 'key_invalid'
  | 'token_refused'
  /** 403/404 on the file: not shared with the service account, or deleted. */
  | 'file_not_accessible'
  | 'rate_limited'
  | 'google_error'

export class GoogleError extends Error {
  constructor(
    readonly code: GoogleErrorCode,
    readonly status: number | null,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code)
  }
}

/** Arabic text for the admin (alerts, link card): what happened and what to do. */
export function googleErrorMessage(code: GoogleErrorCode, serviceAccountEmail?: string): string {
  const who = serviceAccountEmail ? `«${serviceAccountEmail}»` : 'حساب المزامنة'
  switch (code) {
    case 'key_missing':
      return 'مفتاح حساب خدمة Google غير مضاف. أضفه في Cloudflare باسم GOOGLE_SERVICE_ACCOUNT_KEY.'
    case 'key_invalid':
      return 'مفتاح حساب خدمة Google غير صالح. أنشئ مفتاح JSON جديداً وضعه كاملاً في GOOGLE_SERVICE_ACCOUNT_KEY.'
    case 'token_refused':
      return 'رفضت Google مفتاح حساب الخدمة (قد يكون حُذف أو عُطّل). أنشئ مفتاحاً جديداً وضعه في Cloudflare.'
    case 'file_not_accessible':
      return `لا يمكن فتح الملف: غير مشارَك مع ${who} أو حُذف. شاركه معه بصلاحية Editor.`
    case 'rate_limited':
      return 'تجاوزت المزامنة حدّ طلبات Google مؤقتاً. ستُستأنف تلقائياً خلال دقيقة.'
    case 'google_error':
      return 'تعذّر الاتصال بـ Google الآن. ستُعاد المحاولة تلقائياً.'
  }
}

export function parseServiceAccountKey(secret: string | undefined): ServiceAccountKey {
  if (secret === undefined || secret.trim() === '') throw new GoogleError('key_missing', null)
  let json: unknown
  try {
    json = JSON.parse(secret)
  } catch {
    throw new GoogleError('key_invalid', null, 'not JSON')
  }
  const k = json as Record<string, unknown>
  if (k.type !== 'service_account' || typeof k.client_email !== 'string' || typeof k.private_key !== 'string') {
    throw new GoogleError('key_invalid', null, 'not a service account key')
  }
  return {
    clientEmail: k.client_email,
    privateKeyPem: k.private_key,
    tokenUri: typeof k.token_uri === 'string' ? k.token_uri : 'https://oauth2.googleapis.com/token',
  }
}

const b64url = (bytes: Uint8Array): string => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const b64urlText = (text: string): string => b64url(new TextEncoder().encode(text))

async function importKey(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '')
  let der: Uint8Array
  try {
    der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0))
  } catch {
    throw new GoogleError('key_invalid', null, 'private key is not base64')
  }
  try {
    return await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  } catch {
    throw new GoogleError('key_invalid', null, 'private key not importable')
  }
}

/** The signed assertion for the JWT bearer grant (RFC 7523). `now` in epoch seconds. */
export async function signAssertion(key: ServiceAccountKey, scopes: readonly string[], now: number): Promise<string> {
  const header = b64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64urlText(
    JSON.stringify({ iss: key.clientEmail, scope: scopes.join(' '), aud: key.tokenUri, iat: now, exp: now + 3600 }),
  )
  const input = `${header}.${claims}`
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await importKey(key.privateKeyPem), new TextEncoder().encode(input))
  return `${input}.${b64url(new Uint8Array(signature))}`
}

export interface GoogleClientOptions {
  key: ServiceAccountKey
  fetch?: FetchLike
  /** Epoch milliseconds; injectable for tests. */
  now?: () => number
}

export interface DriveChannel {
  id: string
  resourceId: string
  /** Epoch milliseconds. */
  expiration: number
}

/** One row's identity found in the spreadsheet: tab, 0-based row, uid. */
export interface RowIdentityRecord {
  sheetId: number
  row: number
  uid: string
  metadataId: number
}

export class GoogleClient {
  private readonly fetch: FetchLike
  private readonly now: () => number
  private token: { value: string; expiresAt: number } | null = null

  constructor(private readonly options: GoogleClientOptions) {
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init))
    this.now = options.now ?? (() => Date.now())
  }

  get serviceAccountEmail(): string {
    return this.options.key.clientEmail
  }

  async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > this.now()) return this.token.value
    const assertion = await signAssertion(this.options.key, SCOPES, Math.floor(this.now() / 1000))
    const res = await this.fetch(this.options.key.tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    })
    if (res.status === 400 || res.status === 401) throw new GoogleError('token_refused', res.status)
    if (!res.ok) throw new GoogleError(res.status === 429 ? 'rate_limited' : 'google_error', res.status)
    const body = (await res.json()) as { access_token?: string; expires_in?: number }
    if (typeof body.access_token !== 'string') throw new GoogleError('google_error', res.status, 'no access_token')
    this.token = { value: body.access_token, expiresAt: this.now() + (body.expires_in ?? 3600) * 1000 }
    return this.token.value
  }

  private async call<T>(url: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${await this.accessToken()}`)
    if (init.body !== undefined) headers.set('Content-Type', 'application/json')
    const res = await this.fetch(url, { ...init, headers })
    if (res.status === 401) {
      this.token = null
      throw new GoogleError('token_refused', 401)
    }
    if (res.status === 403 || res.status === 404) {
      // A 403 can also be a quota error; Google says so in the reason.
      const text = await res.text()
      if (res.status === 403 && /rateLimitExceeded|RATE_LIMIT_EXCEEDED|userRateLimitExceeded/.test(text)) {
        throw new GoogleError('rate_limited', 403)
      }
      throw new GoogleError('file_not_accessible', res.status)
    }
    if (res.status === 429) throw new GoogleError('rate_limited', 429)
    if (!res.ok) throw new GoogleError('google_error', res.status)
    return (await res.json()) as T
  }

  /** Title, and every tab's id and title, in tab order. */
  async spreadsheet(spreadsheetId: string): Promise<{ title: string; tabs: { sheetId: number; title: string }[] }> {
    const fields = 'properties.title,sheets.properties(sheetId,title)'
    const body = await this.call<{ properties?: { title?: string }; sheets?: { properties?: { sheetId?: number; title?: string } }[] }>(
      `${SHEETS}/${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent(fields)}`,
    )
    return {
      title: body.properties?.title ?? '',
      tabs: (body.sheets ?? []).map((s) => ({ sheetId: s.properties?.sheetId ?? 0, title: s.properties?.title ?? '' })),
    }
  }

  /** Values of whole tabs (header row first), unformatted, dates as serial numbers. */
  async tabValues(spreadsheetId: string, titles: readonly string[]): Promise<Map<string, unknown[][]>> {
    const params = new URLSearchParams({ valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER', majorDimension: 'ROWS' })
    for (const t of titles) params.append('ranges', quoteTab(t))
    const body = await this.call<{ valueRanges?: { values?: unknown[][] }[] }>(
      `${SHEETS}/${encodeURIComponent(spreadsheetId)}/values:batchGet?${params.toString()}`,
    )
    const out = new Map<string, unknown[][]>()
    titles.forEach((t, i) => out.set(t, body.valueRanges?.[i]?.values ?? []))
    return out
  }

  /** Every row identity in the spreadsheet (developer metadata on rows). */
  async rowIdentities(spreadsheetId: string): Promise<RowIdentityRecord[]> {
    const body = await this.call<{
      matchedDeveloperMetadata?: {
        developerMetadata?: {
          metadataId?: number
          metadataValue?: string
          location?: { dimensionRange?: { sheetId?: number; dimension?: string; startIndex?: number } }
        }
      }[]
    }>(`${SHEETS}/${encodeURIComponent(spreadsheetId)}/developerMetadata:search`, {
      method: 'POST',
      body: JSON.stringify({ dataFilters: [{ developerMetadataLookup: { metadataKey: ROW_UID_KEY } }] }),
    })
    const out: RowIdentityRecord[] = []
    for (const m of body.matchedDeveloperMetadata ?? []) {
      const d = m.developerMetadata
      const range = d?.location?.dimensionRange
      if (!d || !range || range.dimension !== 'ROWS' || typeof d.metadataValue !== 'string') continue
      out.push({ sheetId: range.sheetId ?? 0, row: range.startIndex ?? 0, uid: d.metadataValue, metadataId: d.metadataId ?? 0 })
    }
    return out
  }

  /**
   * One batch: new row identities, then cell writes (USER_ENTERED, so a
   * written `YYYY-MM-DD` takes the column's date format).
   */
  async write(
    spreadsheetId: string,
    changes: {
      identities?: { sheetId: number; row: number; uid: string }[]
      cells?: { tabTitle: string; row: number; column: number; value: string | number | null }[]
    },
  ): Promise<void> {
    const requests = (changes.identities ?? []).map((i) => ({
      createDeveloperMetadata: {
        developerMetadata: {
          metadataKey: ROW_UID_KEY,
          metadataValue: i.uid,
          visibility: 'PROJECT',
          location: { dimensionRange: { sheetId: i.sheetId, dimension: 'ROWS', startIndex: i.row, endIndex: i.row + 1 } },
        },
      },
    }))
    if (requests.length > 0) {
      await this.call(`${SHEETS}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests }) })
    }
    const cells = changes.cells ?? []
    if (cells.length > 0) {
      await this.call(`${SHEETS}/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({
          valueInputOption: 'USER_ENTERED',
          data: cells.map((c) => ({ range: `${quoteTab(c.tabTitle)}!${a1(c.row, c.column)}`, values: [[c.value ?? '']] })),
        }),
      })
    }
  }

  /** Last modification of the file (cheap; the fallback check every minute). */
  async modifiedTime(fileId: string): Promise<string> {
    const body = await this.call<{ modifiedTime?: string }>(`${DRIVE}/${encodeURIComponent(fileId)}?fields=modifiedTime&supportsAllDrives=true`)
    if (typeof body.modifiedTime !== 'string') throw new GoogleError('google_error', 200, 'no modifiedTime')
    return body.modifiedTime
  }

  /** Push notifications for the file to `address` (HTTPS). Google caps a file channel at one day. */
  async watch(fileId: string, channel: { id: string; address: string; token: string; ttlMs: number }): Promise<DriveChannel> {
    const body = await this.call<{ id?: string; resourceId?: string; expiration?: string }>(
      `${DRIVE}/${encodeURIComponent(fileId)}/watch?supportsAllDrives=true`,
      {
        method: 'POST',
        body: JSON.stringify({
          id: channel.id,
          type: 'web_hook',
          address: channel.address,
          token: channel.token,
          expiration: String(this.now() + channel.ttlMs),
        }),
      },
    )
    if (typeof body.resourceId !== 'string') throw new GoogleError('google_error', 200, 'no resourceId')
    return { id: body.id ?? channel.id, resourceId: body.resourceId, expiration: Number(body.expiration ?? this.now() + channel.ttlMs) }
  }

  async stopChannel(channel: { id: string; resourceId: string }): Promise<void> {
    await this.call('https://www.googleapis.com/drive/v3/channels/stop', { method: 'POST', body: JSON.stringify(channel) })
  }
}

/** A tab title as an A1 range prefix: always quoted, quotes doubled. */
export function quoteTab(title: string): string {
  return `'${title.replace(/'/g, "''")}'`
}

/** 0-based row and column → A1 (e.g. 0,0 → A1; 4,27 → AB5). */
export function a1(row: number, column: number): string {
  let n = column + 1
  let letters = ''
  while (n > 0) {
    const r = (n - 1) % 26
    letters = String.fromCharCode(65 + r) + letters
    n = Math.floor((n - 1) / 26)
  }
  return `${letters}${row + 1}`
}
