// Request pipeline shared by every endpoint: mandatory headers, the shared
// rate limiter, retries (429 / 5xx), error mapping, conditional GET and
// pagination (spec §9.2.9, §9.2.10, §9.4, Appendix A-1; bc-api README).
//
// The only IO is the injected `fetch`. The access token is passed on every
// call and is used for the Authorization header only: it is never stored,
// logged, put in a cache key or copied into an error.

import {
  AccountInactiveError,
  BadRequestError,
  BasecampError,
  BasecampHttpError,
  type BasecampErrorInit,
  ForbiddenError,
  type HttpMethod,
  LimitReachedError,
  NetworkError,
  NotFoundError,
  RateLimitedError,
  ServerError,
  UnauthorizedError,
  UnexpectedResponseError,
  ValidationError,
} from './errors'
import type { RateLimiter } from './limiter'
import { makePaged, type Page, type Paged, parseNextLink, parseTotalCount } from './pagination'

// ---------------------------------------------------------------------------
// Injected IO
// ---------------------------------------------------------------------------

/** What the client passes to `fetch`. The platform `fetch` (Workers, Node 18+) satisfies `FetchLike`. */
export interface FetchInit {
  method: HttpMethod
  headers: Record<string, string>
  /** A stream only for attachment uploads (`BinarySource`), with an explicit Content-Length. */
  body?: string | ArrayBuffer | ReadableStream<Uint8Array>
  /** Never follow a redirect with the Authorization header attached. */
  redirect: 'manual'
}

/** The part of `Response` the client reads. `body` only for downloads. */
export interface FetchResponse {
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
  body?: ReadableStream<Uint8Array> | null
}

/**
 * A file read from storage for an upload (phase 5, attachments.md). A stream
 * can be read once, so `open()` is called again for every attempt (a retried
 * 429 / 5xx); `byteLength` is sent as Content-Length and must be exact.
 */
export interface BinarySource {
  byteLength: number
  open(): ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>
}

/** A file streamed back from Basecamp (`download`). */
export interface DownloadResult {
  contentType: string | null
  contentLength: number | null
  body: ReadableStream<Uint8Array>
}

export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>

/** What a conditional-GET cache stores. `body` is opaque to the cache; it must be JSON-serialisable. */
export interface CacheEntry {
  etag?: string
  lastModified?: string
  body: unknown
}

/** E.g. a KV namespace wrapper. Keys never contain a token; they are `scope` + URL. */
export interface ConditionalCache {
  get(key: string): Promise<CacheEntry | null>
  put(key: string, entry: CacheEntry): Promise<void>
}

/** Result of a conditional GET: on 304 `data` is the cached copy. */
export interface Conditional<T> {
  notModified: boolean
  data: T
}

export interface RetryPolicy {
  /** Total attempts when Basecamp answers 500/502/503/504. Spec §9.2.8: 5. */
  maxServerErrorAttempts: number
  /** First 5xx backoff; doubles on each retry. */
  baseBackoffMs: number
  maxBackoffMs: number
  /** Total attempts when Basecamp answers 429. */
  maxRateLimitAttempts: number
  /**
   * Longest `Retry-After` the client waits in-process. A longer one is thrown
   * as `RateLimitedError` (with `retryAfterMs`) for the queue to delay.
   */
  maxRetryAfterMs: number
}

// OPEN: the 429 attempt cap and the longest in-process wait are not in the spec. See OPEN_QUESTIONS.md.
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxServerErrorAttempts: 5,
  baseBackoffMs: 1000,
  maxBackoffMs: 30_000,
  maxRateLimitAttempts: 5,
  maxRetryAfterMs: 60_000,
}

/**
 * README "Handling errors": these "may be retried with exponential backoff".
 * OPEN: the spec says "5xx"; only the four the docs list are retried, 507 is
 * a limit, any other 5xx is thrown without retry. Retrying a POST that
 * creates something can duplicate it if Basecamp committed before failing. See
 * OPEN_QUESTIONS.md.
 */
const RETRYABLE_SERVER_STATUSES = new Set([500, 502, 503, 504])

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export interface HttpCoreOptions {
  accountId: number | string
  fetch: FetchLike
  userAgent: string
  limiter: RateLimiter
  cache?: ConditionalCache
  sleep: (ms: number) => Promise<void>
  now: () => number
  retry: RetryPolicy
}

export interface SendSpec {
  method: HttpMethod
  /** Path relative to the account base URL (starting with `/`), or an absolute URL from a `Link` header. */
  target: string
  query?: Record<string, string | undefined>
  /** JSON body (POST/PUT). */
  json?: unknown
  /** Raw body with its own content type (attachments only). */
  binary?: { data: ArrayBuffer | BinarySource; contentType: string }
  /** Conditional GET: cache key for this exact URL and caller scope. */
  cacheKey?: string
  /**
   * How to read a 429. `retry` (default): rate limit, wait `Retry-After`.
   * `retry-only-with-retry-after`: a 429 without `Retry-After` is an account
   * limit (people.md "Add and remove clients on a project"), thrown as
   * `LimitReachedError` without retrying.
   */
  on429?: 'retry' | 'retry-only-with-retry-after'
}

export interface SendResult {
  status: number
  /** Parsed JSON, or undefined for an empty body (204). */
  body: unknown
  /** rel="next" URL, already checked to stay inside the account. */
  next: string | null
  total: number | null
  /** True when Basecamp answered 304 and `body` came from the cache. */
  fromCache: boolean
}

/** What the cache stores in `CacheEntry.body`. */
interface CachedBody {
  json: unknown
  next: string | null
  total: number | null
}

const MAX_ERROR_TEXT = 2000
const MAX_PAGES = 10_000
const TOKEN_PATTERN = /^[\x21-\x7e]+$/

export class HttpCore {
  readonly baseUrl: string
  private readonly o: HttpCoreOptions

  constructor(options: HttpCoreOptions) {
    const accountId = String(options.accountId)
    if (!/^[1-9]\d*$/.test(accountId)) throw new TypeError('accountId must be a positive integer')
    if (typeof options.userAgent !== 'string' || options.userAgent.trim() === '') {
      throw new TypeError('userAgent is required (Basecamp answers 400 without it)')
    }
    this.baseUrl = `https://3.basecampapi.com/${accountId}`
    this.o = options
  }

  async send(token: string, spec: SendSpec): Promise<SendResult> {
    assertToken(token)
    const url = this.resolve(spec)
    const path = url.slice(this.baseUrl.length)
    const { method } = spec

    const headers: Record<string, string> = {
      'User-Agent': this.o.userAgent,
      Authorization: `Bearer ${token}`,
    }
    let body: string | ArrayBuffer | undefined
    let source: BinarySource | undefined
    if (spec.binary) {
      headers['Content-Type'] = spec.binary.contentType
      headers['Content-Length'] = String(spec.binary.data.byteLength)
      if (isBinarySource(spec.binary.data)) source = spec.binary.data
      else body = spec.binary.data
    } else if (method === 'POST' || method === 'PUT') {
      // Mandatory on every POST/PUT, even without a body (spec §9.2.10; 415 otherwise).
      headers['Content-Type'] = 'application/json; charset=utf-8'
      if (spec.json !== undefined) body = JSON.stringify(spec.json)
    } else if (spec.json !== undefined) {
      throw new TypeError(`${method} requests carry no body`)
    }

    const cache = spec.cacheKey !== undefined && method === 'GET' ? this.o.cache : undefined
    const cached = cache ? await cache.get(spec.cacheKey as string) : null
    if (cached?.etag) headers['If-None-Match'] = cached.etag
    if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified

    const init: FetchInit = { method, headers, redirect: 'manual' }
    if (body !== undefined) init.body = body

    const errInit = (status: number | null, attempts: number, details?: unknown, cause?: unknown): BasecampErrorInit => ({
      status,
      method,
      path,
      attempts,
      details,
      cause,
    })

    let attempts = 0
    let serverErrors = 0
    let rateLimits = 0
    for (;;) {
      attempts += 1
      await this.o.limiter.acquire()
      let res: FetchResponse
      try {
        // A stored file is opened again for every attempt: a stream is read once.
        if (source) init.body = await source.open()
        res = await this.o.fetch(url, init)
      } catch (cause) {
        // OPEN: network failures are not covered by the docs; not retried here (see OPEN_QUESTIONS.md).
        throw new NetworkError(errInit(null, attempts, undefined, cause))
      }
      const status = res.status

      if (status >= 200 && status < 300) {
        const json = await readJson(res, () => errInit(status, attempts))
        const next = this.checkNext(parseNextLink(res.headers.get('Link')), errInit(status, attempts))
        const total = parseTotalCount(res.headers.get('X-Total-Count'))
        if (cache) {
          const etag = res.headers.get('ETag')
          const lastModified = res.headers.get('Last-Modified')
          if (etag || lastModified) {
            const entry: CacheEntry = { body: { json, next, total } satisfies CachedBody }
            if (etag) entry.etag = etag
            if (lastModified) entry.lastModified = lastModified
            await cache.put(spec.cacheKey as string, entry)
          }
        }
        return { status, body: json, next, total, fromCache: false }
      }

      if (status === 304) {
        await drain(res)
        if (!cached) throw new UnexpectedResponseError(errInit(status, attempts), '304 without a cached copy')
        const c = cached.body as Partial<CachedBody> | null
        if (!c || typeof c !== 'object' || !('json' in c)) {
          throw new UnexpectedResponseError(errInit(status, attempts), 'cached entry has an unknown shape')
        }
        return { status, body: c.json, next: c.next ?? null, total: c.total ?? null, fromCache: true }
      }

      if (status === 429) {
        const details = await readDetails(res)
        rateLimits += 1
        const retryAfterMs = parseRetryAfter(res.headers.get('Retry-After'), this.o.now())
        if (spec.on429 === 'retry-only-with-retry-after' && retryAfterMs === null) {
          throw new LimitReachedError(errInit(status, attempts, details))
        }
        const wait = retryAfterMs ?? this.backoff(rateLimits)
        if (rateLimits >= this.o.retry.maxRateLimitAttempts || wait > this.o.retry.maxRetryAfterMs) {
          throw new RateLimitedError(errInit(status, attempts, details), retryAfterMs)
        }
        this.o.limiter.pauseFor?.(wait)
        await this.o.sleep(wait)
        continue
      }

      if (RETRYABLE_SERVER_STATUSES.has(status)) {
        const details = await readDetails(res)
        serverErrors += 1
        if (serverErrors >= this.o.retry.maxServerErrorAttempts) {
          throw new ServerError(errInit(status, attempts, details), true)
        }
        await this.o.sleep(this.backoff(serverErrors))
        continue
      }

      throw mapError(res, errInit(status, attempts, await readDetails(res)))
    }
  }

  /**
   * GET of a file Basecamp stores (`download_url` of an attachment, phase 5),
   * streamed back. The URL must be inside this account: the API host or
   * `storage.3.basecamp.com/{account}/`; anything else is refused before any
   * request, so the token never leaves Basecamp. A redirect is followed (at
   * most 3 hops, HTTPS only) WITHOUT the Authorization header.
   * One attempt: a 429 or 5xx is thrown (`retryable`) for the caller to retry.
   * OPEN: attachments.md / rich_text.md document `download_url` but not
   * whether it needs the token or redirects (see OPEN_QUESTIONS.md #14).
   */
  async download(token: string, url: string): Promise<DownloadResult> {
    assertToken(token)
    const start = this.checkDownloadUrl(url)
    const errAt = (status: number | null, details?: unknown, cause?: unknown): BasecampErrorInit => ({
      status,
      method: 'GET',
      path: start.pathname,
      attempts: 1,
      details,
      cause,
    })
    let target = start
    let withToken = true
    for (let hop = 0; hop <= 3; hop++) {
      const headers: Record<string, string> = { 'User-Agent': this.o.userAgent }
      if (withToken) headers['Authorization'] = `Bearer ${token}`
      await this.o.limiter.acquire()
      let res: FetchResponse
      try {
        res = await this.o.fetch(target.href, { method: 'GET', headers, redirect: 'manual' })
      } catch (cause) {
        throw new NetworkError(errAt(null, undefined, cause))
      }
      const status = res.status
      if (status >= 200 && status < 300) {
        if (!res.body) throw new UnexpectedResponseError(errAt(status), 'download has no body')
        const length = Number(res.headers.get('Content-Length'))
        return {
          contentType: res.headers.get('Content-Type'),
          contentLength: Number.isSafeInteger(length) && length >= 0 && res.headers.get('Content-Length') !== null ? length : null,
          body: res.body,
        }
      }
      if (status >= 300 && status < 400) {
        await drain(res)
        const location = res.headers.get('Location')
        let next: URL | null = null
        try {
          next = location ? new URL(location, target) : null
        } catch {
          next = null
        }
        if (!next || next.protocol !== 'https:') throw new UnexpectedResponseError(errAt(status), 'redirect without an HTTPS location')
        target = next
        // Never send the token to wherever the redirect points.
        withToken = false
        continue
      }
      const details = await readDetails(res)
      if (status === 429) throw new RateLimitedError(errAt(status, details), parseRetryAfter(res.headers.get('Retry-After'), this.o.now()))
      if (RETRYABLE_SERVER_STATUSES.has(status)) throw new ServerError(errAt(status, details), true)
      throw mapError(res, errAt(status, details))
    }
    throw new UnexpectedResponseError(errAt(null), 'too many redirects')
  }

  private checkDownloadUrl(url: string): URL {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new TypeError('download URL is not a URL')
    }
    const account = this.baseUrl.slice(this.baseUrl.lastIndexOf('/') + 1)
    const allowed = [`${this.baseUrl}/`, `https://storage.3.basecamp.com/${account}/`]
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || !allowed.some((prefix) => parsed.href.startsWith(prefix))) {
      throw new TypeError('download URL must be a file of this Basecamp account')
    }
    return parsed
  }

  /** A request whose 2xx answer must have a JSON body. */
  async json(token: string, spec: SendSpec): Promise<unknown> {
    const r = await this.send(token, spec)
    if (r.body === undefined) throw new UnexpectedResponseError(this.errAt(spec, r.status), 'empty body')
    return r.body
  }

  /**
   * `json` followed by `map` (a normaliser or shape check). Anything `map`
   * throws becomes an `UnexpectedResponseError` for this method and path,
   * with the original error as `cause`.
   */
  async parse<T>(token: string, spec: SendSpec, map: (raw: unknown) => T): Promise<T> {
    const r = await this.send(token, spec)
    if (r.body === undefined) throw new UnexpectedResponseError(this.errAt(spec, r.status), 'empty body')
    return this.mapOrThrow(map, r.body, spec, r.status)
  }

  /** A request answered with 204 (or any 2xx whose body is ignored). */
  async none(token: string, spec: SendSpec): Promise<void> {
    await this.send(token, spec)
  }

  /** Conditional GET of one resource. Requires a cache; without one it is a plain GET. */
  async getIfChanged(token: string, path: string, scope: string, query?: Record<string, string | undefined>): Promise<Conditional<unknown>> {
    const spec: SendSpec = { method: 'GET', target: path, query, cacheKey: this.cacheKey(scope, this.resolve({ method: 'GET', target: path, query })) }
    const r = await this.send(token, spec)
    if (r.body === undefined) throw new UnexpectedResponseError(this.errAt(spec, r.status), 'empty body')
    return { notModified: r.fromCache, data: r.body }
  }

  /** Lazily paginated GET; `map` turns each raw item into the result type. */
  paged<T>(token: string, path: string, query: Record<string, string | undefined> | undefined, map: (raw: unknown) => T): Paged<T> {
    assertToken(token)
    const self = this
    return makePaged<T>(async function* (): AsyncGenerator<Page<T>> {
      for await (const page of self.rawPages(token, path, query, undefined)) {
        yield { items: page.items.map((raw) => self.mapOrThrow(map, raw, page.spec, page.status)), totalCount: page.total }
      }
    })
  }

  /**
   * Conditional GET of a whole paginated collection. Every page is requested
   * with its own validators; the collection is `notModified` only when every
   * page answered 304. A 304 page continues from the `next` link cached with it.
   * OPEN: spec §9.4 reads "304 = no change" for the list; with pagination a
   * 304 on page 1 says nothing about page 2. See OPEN_QUESTIONS.md.
   */
  async collectIfChanged<T>(
    token: string,
    path: string,
    scope: string,
    query: Record<string, string | undefined> | undefined,
    map: (raw: unknown) => T,
  ): Promise<Conditional<T[]>> {
    assertToken(token)
    let notModified = true
    const data: T[] = []
    for await (const page of this.rawPages(token, path, query, scope)) {
      if (!page.fromCache) notModified = false
      for (const raw of page.items) data.push(this.mapOrThrow(map, raw, page.spec, page.status))
    }
    return { notModified, data }
  }

  private async *rawPages(
    token: string,
    path: string,
    query: Record<string, string | undefined> | undefined,
    scope: string | undefined,
  ): AsyncGenerator<{ items: unknown[]; total: number | null; fromCache: boolean; spec: SendSpec; status: number }> {
    let target: string | null = this.resolve({ method: 'GET', target: path, query })
    const seen = new Set<string>()
    while (target !== null) {
      if (seen.has(target) || seen.size >= MAX_PAGES) {
        throw new UnexpectedResponseError(this.errAt({ method: 'GET', target }, null), 'pagination does not terminate')
      }
      seen.add(target)
      const spec: SendSpec = { method: 'GET', target }
      if (scope !== undefined) spec.cacheKey = this.cacheKey(scope, target)
      const r = await this.send(token, spec)
      if (!Array.isArray(r.body)) throw new UnexpectedResponseError(this.errAt(spec, r.status), 'expected a JSON array')
      yield { items: r.body, total: r.total, fromCache: r.fromCache, spec, status: r.status }
      target = r.next
    }
  }

  private mapOrThrow<T>(map: (raw: unknown) => T, raw: unknown, spec: SendSpec, status: number): T {
    try {
      return map(raw)
    } catch (cause) {
      if (cause instanceof BasecampError) throw cause
      const detail = cause instanceof Error ? cause.message : 'response has an unexpected shape'
      throw new UnexpectedResponseError({ ...this.errAt(spec, status), cause }, detail)
    }
  }

  private cacheKey(scope: string, url: string): string {
    if (typeof scope !== 'string' || scope.trim() === '') throw new TypeError('cacheScope is required for a conditional GET')
    return `basecamp:${scope}:${url}`
  }

  /** Absolute URL for a spec; absolute targets must already be inside this account. */
  private resolve(spec: Pick<SendSpec, 'target' | 'query' | 'method'>): string {
    let url: string
    if (spec.target.startsWith('/')) {
      url = this.baseUrl + spec.target
    } else if (spec.target.startsWith(`${this.baseUrl}/`)) {
      url = spec.target
    } else {
      throw new TypeError('request target must be a path or a URL inside this Basecamp account')
    }
    const pairs = Object.entries(spec.query ?? {}).filter((e): e is [string, string] => e[1] !== undefined)
    if (pairs.length > 0) {
      const qs = pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
      url += (url.includes('?') ? '&' : '?') + qs
    }
    return url
  }

  /** A `next` link is followed verbatim, but never outside this account's API (it would receive the token). */
  private checkNext(next: string | null, init: BasecampErrorInit): string | null {
    if (next === null) return null
    if (!next.startsWith(`${this.baseUrl}/`)) {
      throw new UnexpectedResponseError(init, 'next page link points outside this Basecamp account')
    }
    return next
  }

  private backoff(n: number): number {
    return Math.min(this.o.retry.maxBackoffMs, this.o.retry.baseBackoffMs * 2 ** (n - 1))
  }

  private errAt(spec: Pick<SendSpec, 'method' | 'target' | 'query'>, status: number | null): BasecampErrorInit {
    return { status, method: spec.method, path: this.resolve(spec).slice(this.baseUrl.length) }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertToken(token: string): void {
  // Checked without echoing the value anywhere.
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    throw new TypeError('an access token (printable ASCII, no spaces) is required for every Basecamp call')
  }
}

/** `Retry-After` as milliseconds: delta-seconds or an HTTP date. Null when absent or unreadable. */
export function parseRetryAfter(header: string | null, nowMs: number): number | null {
  if (header === null) return null
  const v = header.trim()
  if (/^\d+$/.test(v)) return Number(v) * 1000
  const at = Date.parse(v)
  if (Number.isNaN(at)) return null
  return Math.max(0, at - nowMs)
}

async function readJson(res: FetchResponse, init: () => BasecampErrorInit): Promise<unknown> {
  const text = await res.text()
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch (cause) {
    throw new UnexpectedResponseError({ ...init(), cause }, 'body is not valid JSON')
  }
}

function isBinarySource(data: ArrayBuffer | BinarySource): data is BinarySource {
  return typeof (data as Partial<BinarySource>).open === 'function'
}

async function readDetails(res: FetchResponse): Promise<unknown> {
  let text: string
  try {
    text = await res.text()
  } catch {
    return undefined
  }
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT)}…` : text
  }
}

async function drain(res: FetchResponse): Promise<void> {
  try {
    await res.text()
  } catch {
    // nothing to free
  }
}

function mapError(res: FetchResponse, init: BasecampErrorInit): Error {
  const status = res.status
  switch (status) {
    case 400:
      return new BadRequestError(init)
    case 401:
      return new UnauthorizedError(init)
    case 403: {
      const d = init.details
      const reason = typeof d === 'object' && d !== null && typeof (d as { reason?: unknown }).reason === 'string' ? (d as { reason: string }).reason : null
      return new ForbiddenError(init, reason)
    }
    case 404: {
      const reason = res.headers.get('Reason')
      if (reason !== null && reason.trim().toLowerCase() === 'account inactive') return new AccountInactiveError(init)
      return new NotFoundError(init, reason)
    }
    case 422:
      return new ValidationError(init)
    case 507:
      return new LimitReachedError(init)
    default:
      if (status >= 500) return new ServerError(init, false)
      return new BasecampHttpError(init)
  }
}
