// REST client for the contract in packages/shared/src/api.ts. It calls exactly
// those endpoints and turns every failure into an `ApiRequestError` whose
// message is Arabic: the API's own `message` when it sent one, otherwise a
// fallback that says what happened and what to do (spec §12.2).
//
// 401 (naf-auth: `{ ok:false, error:"unauthorized", login }`) calls
// `onUnauthorized` with the login URL; the app sends the browser there.

import type {
  CreateWorkbookRequest,
  CreateWorkbookResponse,
  MeResponse,
  SaveSnapshotRequest,
  SaveSnapshotResponse,
  WorkbookListResponse,
  WorkbookResponse,
} from '@naf-sheets/shared'
import { t } from '../strings'
import type { SaveErrorKind } from './autosave'

export class ApiRequestError extends Error {
  /** HTTP status; 0 when the request never got a response. */
  readonly status: number
  /** `ApiError.error`, or a local code (`network_error`, `invalid_response`, `http_<status>`). */
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
    this.code = code
  }
}

export const isAbortError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'

export const isConflictError = (error: unknown): boolean => error instanceof ApiRequestError && error.status === 409

/** Worth retrying without user action: no response, rate limited, or a server failure. */
export const isRetryableError = (error: unknown): boolean =>
  error instanceof ApiRequestError && (error.status === 0 || error.status === 429 || error.status >= 500)

/** The Arabic message to show for any error, API or not. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message
  return t.errors.generic
}

/** How autosave treats a failed snapshot PUT: 409 stops it, transient failures retry, the rest wait for the user. */
export function classifySaveError(error: unknown): { kind: SaveErrorKind; message: string } {
  const message = errorMessage(error)
  if (isConflictError(error)) return { kind: 'conflict', message }
  if (isRetryableError(error)) return { kind: 'retryable', message }
  return { kind: 'fatal', message }
}

type JsonObject = Record<string, unknown>
const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Fallback Arabic message for an error body that carries no `message`. */
export function fallbackMessage(status: number, body: JsonObject | null): string {
  const code = typeof body?.error === 'string' ? body.error : ''
  if (status === 401) return t.errors.unauthorized
  if (status === 403 && code === 'access_denied') {
    // naf-auth sends a reason code, never a sentence (naf-auth README, /denied).
    const reason = typeof body?.reason === 'string' ? body.reason : ''
    return t.denied.reasons[reason] ?? t.errors.forbidden
  }
  if (status === 403) return t.errors.forbidden
  if (status === 404) return t.errors.notFound
  if (status === 409) return t.editor.conflictFallback
  if (status === 429) return t.errors.tooManyRequests
  if (status === 503 && code === 'auth_unavailable') return t.errors.authUnavailable
  if (status >= 500) return t.errors.server
  return t.errors.generic
}

export function toApiRequestError(status: number, body: unknown): ApiRequestError {
  const obj = isObject(body) ? body : null
  const code = typeof obj?.error === 'string' && obj.error ? obj.error : `http_${status}`
  const message = typeof obj?.message === 'string' && obj.message.trim() ? obj.message : fallbackMessage(status, obj)
  return new ApiRequestError(status, code, message)
}

export interface ApiClientOptions {
  /** Defaults to the global `fetch`, looked up at call time. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>
  /** Called on every 401 before the error is thrown; `login` is the body's login URL if any. */
  onUnauthorized?: (login: string | undefined) => void
}

type Method = 'GET' | 'POST' | 'PUT'

export function createApiClient(options: ApiClientOptions = {}) {
  const doFetch = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init))

  async function request<T>(method: Method, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    const init: RequestInit = { method, headers, credentials: 'same-origin' }
    if (signal) init.signal = signal
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json; charset=utf-8'
      init.body = JSON.stringify(body)
    }

    let response: Response
    try {
      response = await doFetch(path, init)
    } catch (error) {
      if (isAbortError(error)) throw error
      throw new ApiRequestError(0, 'network_error', t.errors.network)
    }

    let payload: unknown = undefined
    const text = await response.text().catch(() => '')
    if (text) {
      try {
        payload = JSON.parse(text)
      } catch {
        payload = undefined
      }
    }

    if (response.ok) {
      if (!isObject(payload)) throw new ApiRequestError(response.status, 'invalid_response', t.errors.invalidResponse)
      return payload as T
    }
    if (response.status === 401) {
      const login = isObject(payload) && typeof payload.login === 'string' ? payload.login : undefined
      options.onUnauthorized?.(login)
    }
    throw toApiRequestError(response.status, payload)
  }

  const workbookPath = (id: string) => `/api/workbooks/${encodeURIComponent(id)}`

  return {
    /** GET /api/me */
    me: (signal?: AbortSignal) => request<MeResponse>('GET', '/api/me', undefined, signal),
    /** GET /api/workbooks?q= */
    listWorkbooks: (q: string, signal?: AbortSignal) => {
      const query = q.trim()
      const path = query ? `/api/workbooks?q=${encodeURIComponent(query)}` : '/api/workbooks'
      return request<WorkbookListResponse>('GET', path, undefined, signal)
    },
    /** POST /api/workbooks — phase 1: blank workbooks only. */
    createWorkbook: (title: string) => {
      const body: CreateWorkbookRequest = { title, source: 'blank' }
      return request<CreateWorkbookResponse>('POST', '/api/workbooks', body)
    },
    /** GET /api/workbooks/:id */
    getWorkbook: (id: string, signal?: AbortSignal) => request<WorkbookResponse>('GET', workbookPath(id), undefined, signal),
    /** PUT /api/workbooks/:id/snapshot — 409 `version_conflict` when `baseVersion` is stale. */
    saveSnapshot: (id: string, body: SaveSnapshotRequest) =>
      request<SaveSnapshotResponse>('PUT', `${workbookPath(id)}/snapshot`, body),
  }
}

export type ApiClient = ReturnType<typeof createApiClient>

// ---------------------------------------------------------------------------
// Sign-in redirect (naf-auth)
// ---------------------------------------------------------------------------

// Control characters a browser may drop from a Location header.
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/

function looksSafe(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//') && !value.includes(':') && !value.includes('\\') && !CONTROL_CHARS.test(value)
}

/**
 * Same rule as naf-auth's `safeNext`: a path that starts with exactly one slash,
 * with no colon, no backslash and no control character, checked both as given
 * and fully URL-decoded. The browser is the only side that knows the page the
 * user stands on, so it attaches it to the login URL (naf-auth middleware.js).
 */
export function isSafeNext(value: string): boolean {
  if (!looksSafe(value)) return false
  let current = value
  for (let round = 0; round < 4; round++) {
    let decoded: string
    try {
      decoded = decodeURIComponent(current)
    } catch {
      return false
    }
    if (decoded === current) return looksSafe(current)
    current = decoded
  }
  return false
}

/**
 * The URL to send the browser to after a 401: the `login` from the body, with
 * `next` set to the current page when that page is a safe, non-root path.
 * Returns null when `login` is not an http(s) URL.
 */
export function loginRedirectUrl(login: string, current: { origin: string; pathname: string; search: string }): string | null {
  let url: URL
  try {
    url = new URL(login, current.origin)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const next = current.pathname + current.search
  if (next !== '/' && isSafeNext(next) && !url.searchParams.has('next')) url.searchParams.set('next', next)
  return url.toString()
}

let redirecting = false

/**
 * Send the browser to sign in; several parallel 401s navigate once.
 * OPEN: unsaved editor changes are guarded only by the browser's leave-page
 * prompt (OPEN_QUESTIONS.md #9).
 */
export function redirectToLogin(login: string | undefined): void {
  if (redirecting || typeof window === 'undefined' || !login) return
  const target = loginRedirectUrl(login, window.location)
  if (!target) return
  redirecting = true
  window.location.assign(target)
}

/** The app's client: same origin, 401 goes to sign-in. */
export const api = createApiClient({ onUnauthorized: redirectToLogin })
