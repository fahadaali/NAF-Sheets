// Errors thrown by the Basecamp client (spec §9.2.9, Appendix A-1).
//
// Every error carries the HTTP status, the method, the request path relative
// to the account base URL and a stable machine `code`. None of them ever holds
// the access token or the request headers: messages are built only from the
// method, the path and the status.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

export type BasecampErrorCode =
  /** 429 that could not be waited out (too long, or too many in a row). */
  | 'rate_limited'
  /** 5xx after the retry budget, or a 5xx that is never retried. */
  | 'server_error'
  /** 404: deleted item or missing permission. Never retried. */
  | 'not_found'
  /** 404 with `Reason: Account Inactive`: stop the whole account's sync. */
  | 'account_inactive'
  | 'forbidden'
  | 'unauthorized'
  /** 507: account limit (webhooks, users, projects). */
  | 'limit_reached'
  | 'validation_failed'
  | 'bad_request'
  /** Any other non-2xx status, including an unexpected redirect. */
  | 'http_error'
  /** `fetch` itself failed (DNS, connection reset…). */
  | 'network_error'
  /** 2xx/304 whose body is not what the endpoint documents. */
  | 'unexpected_response'

export interface BasecampErrorInit {
  status: number | null
  method: HttpMethod
  path: string
  /** Parsed JSON body of the error response, or its text (truncated). */
  details?: unknown
  /** How many attempts were made before giving up. */
  attempts?: number
  cause?: unknown
}

export class BasecampError extends Error {
  override readonly name: string = 'BasecampError'
  readonly code: BasecampErrorCode
  readonly status: number | null
  readonly method: HttpMethod
  /** Path relative to `https://3.basecampapi.com/{account_id}`, query included. */
  readonly path: string
  readonly details: unknown
  readonly attempts: number
  /**
   * Whether repeating the same request later can succeed without any change
   * (the queue may re-deliver it). False for 4xx and 507.
   */
  readonly retryable: boolean

  constructor(code: BasecampErrorCode, init: BasecampErrorInit, retryable: boolean, detail?: string) {
    const status = init.status === null ? 'no response' : String(init.status)
    super(`Basecamp ${init.method} ${init.path} failed (${status}, ${code})${detail ? `: ${detail}` : ''}`, {
      cause: init.cause,
    })
    this.code = code
    this.status = init.status
    this.method = init.method
    this.path = init.path
    this.details = init.details
    this.attempts = init.attempts ?? 1
    this.retryable = retryable
  }
}

export class RateLimitedError extends BasecampError {
  override readonly name = 'RateLimitedError'
  /** What Basecamp asked us to wait, in milliseconds (null when it did not say). */
  readonly retryAfterMs: number | null
  constructor(init: BasecampErrorInit, retryAfterMs: number | null) {
    super('rate_limited', init, true, retryAfterMs === null ? undefined : `retry after ${retryAfterMs} ms`)
    this.retryAfterMs = retryAfterMs
  }
}

export class ServerError extends BasecampError {
  override readonly name = 'ServerError'
  constructor(init: BasecampErrorInit, retryable: boolean) {
    super('server_error', init, retryable)
  }
}

export class NotFoundError extends BasecampError {
  override readonly name = 'NotFoundError'
  /** Value of the `Reason` header when present (other than Account Inactive). */
  readonly reason: string | null
  constructor(init: BasecampErrorInit, reason: string | null) {
    super('not_found', init, false)
    this.reason = reason
  }
}

/**
 * Deliberately not a subclass of `NotFoundError`: an inactive account must not
 * be handled like one missing item. Stop the account's sync and alert `admin`.
 */
export class AccountInactiveError extends BasecampError {
  override readonly name = 'AccountInactiveError'
  constructor(init: BasecampErrorInit) {
    super('account_inactive', init, false)
  }
}

export class ForbiddenError extends BasecampError {
  override readonly name = 'ForbiddenError'
  /** `reason` from the JSON body, e.g. `agent_not_permitted`, when present. */
  readonly reason: string | null
  constructor(init: BasecampErrorInit, reason: string | null) {
    super('forbidden', init, false, reason ?? undefined)
    this.reason = reason
  }
}

/** 401: the user's token is expired or revoked. Keep their changes pending (spec §3). */
export class UnauthorizedError extends BasecampError {
  override readonly name = 'UnauthorizedError'
  constructor(init: BasecampErrorInit) {
    super('unauthorized', init, false)
  }
}

export class LimitReachedError extends BasecampError {
  override readonly name = 'LimitReachedError'
  constructor(init: BasecampErrorInit) {
    super('limit_reached', init, false)
  }
}

export class ValidationError extends BasecampError {
  override readonly name = 'ValidationError'
  constructor(init: BasecampErrorInit) {
    super('validation_failed', init, false)
  }
}

export class BadRequestError extends BasecampError {
  override readonly name = 'BadRequestError'
  constructor(init: BasecampErrorInit) {
    super('bad_request', init, false)
  }
}

export class BasecampHttpError extends BasecampError {
  override readonly name = 'BasecampHttpError'
  constructor(init: BasecampErrorInit) {
    super('http_error', init, false)
  }
}

export class NetworkError extends BasecampError {
  override readonly name = 'NetworkError'
  constructor(init: BasecampErrorInit) {
    super('network_error', init, true)
  }
}

export class UnexpectedResponseError extends BasecampError {
  override readonly name = 'UnexpectedResponseError'
  constructor(init: BasecampErrorInit, detail: string) {
    super('unexpected_response', init, false, detail)
  }
}
