// REST contract between apps/web and apps/api.
// Paths are relative to the platform origin. Every error body is `ApiError`.

import type { PlatformRole } from './domain'

/**
 * Stable machine codes of `ApiError.error`: exactly the codes apps/api sends,
 * including the three naf-auth refusals the API completes with an Arabic
 * message (`unauthorized`, `access_denied`, `auth_unavailable`). A new code is
 * added here first.
 */
export type ApiErrorCode =
  // General (apps/api/src/errors.ts)
  | 'unauthorized'
  | 'access_denied'
  | 'auth_unavailable'
  | 'forbidden'
  | 'not_found'
  | 'invalid_json'
  | 'invalid_request'
  | 'queue_unavailable'
  | 'internal'
  // Platform members «أعضاء المنصة» (apps/api/src/routes/platform-members.ts, contract ./api-members.ts)
  | 'cannot_change_self'
  | 'last_active_admin'
  | 'member_changed'
  // Appearance «المظهر» (apps/api/src/appearance/routes.ts)
  | 'invalid_palette'
  // The Basecamp sync account (apps/api/src/basecamp-link/errors.ts; basecamp_project_not_found also from the station)
  | 'basecamp_not_configured'
  | 'basecamp_state_invalid'
  | 'basecamp_authorization_denied'
  | 'basecamp_unavailable'
  | 'basecamp_account_missing'
  | 'basecamp_service_not_linked'
  | 'basecamp_project_not_found'
  // The station (apps/api/src/station/routes.ts)
  | 'admin_only'
  | 'invalid_source'
  | 'invalid_link'
  | 'invalid_change'
  | 'invalid_name'
  | 'unknown_tab'
  | 'tab_already_linked'
  | 'todos_disabled'
  | 'link_not_found'
  | 'name_not_found'
  // The Google service account (apps/api/src/station/google.ts `GoogleErrorCode`)
  | 'key_missing'
  | 'key_invalid'
  | 'token_refused'
  | 'file_not_accessible'
  | 'rate_limited'
  | 'google_error'

/** Every non-2xx JSON response. `message` is Arabic: what happened and what to do (spec §12.2). */
export interface ApiError {
  ok: false
  /** Stable machine code. */
  error: ApiErrorCode
  message: string
  /** naf-auth: where to send the browser to sign in again (401 only). */
  login?: string
  /** Where to send the browser to (re)connect an integration, e.g. `/auth/google/start`. */
  link?: string
}

export interface CurrentUser {
  id: string
  name: string | null
  email: string | null
  role: PlatformRole
}

/** GET /api/me */
export interface MeResponse {
  user: CurrentUser
}
