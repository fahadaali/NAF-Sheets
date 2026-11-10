// Google Sheets import (spec §7.2, §14): endpoints, scope, storage keys and
// limits. Every Google value below was checked on 2026-11-10 against:
//   OAuth 2.0 for web server apps
//     https://developers.google.com/identity/protocols/oauth2/web-server
//   Sheets API v4 spreadsheets.get, field masks, usage limits
//     https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/get
//     https://developers.google.com/workspace/sheets/api/guides/field-masks
//     https://developers.google.com/workspace/sheets/api/limits

import type { Env } from '../env'

/** Bindings this module reads on top of `Env`. Secrets only through `wrangler secret put`. */
export interface GoogleImportEnv extends Env {
  /** OAuth client id (Google Cloud console → Clients). Not secret; may also live in `[vars]`. */
  GOOGLE_CLIENT_ID?: string
  /** Secret: `wrangler secret put GOOGLE_CLIENT_SECRET`. */
  GOOGLE_CLIENT_SECRET?: string
  /** Secret: `wrangler secret put TOKEN_ENCRYPTION_KEY` (32 random bytes, base64; see ../crypto.ts). */
  TOKEN_ENCRYPTION_KEY?: string
}

/** "Google's OAuth 2.0 endpoint is at https://accounts.google.com/o/oauth2/v2/auth". */
export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
/** Code exchange: "call the https://oauth2.googleapis.com/token endpoint". */
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
/** `GET https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}`. */
export const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets'

/**
 * The only scope requested. spreadsheets.get accepts drive, drive.readonly,
 * drive.file, spreadsheets and spreadsheets.readonly; this is the narrowest
 * that reads a file the user pastes a link to, and it cannot modify the file.
 * OPEN: `drive.file` with Google Picker (spec §7.2) needs a browser API key
 * that does not exist yet (apps/api/OPEN_QUESTIONS.md, "Google import" G1).
 */
export const SHEETS_READONLY_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly'

/** Callback path; the redirect URI is this path on the origin the request came in on. */
export const GOOGLE_CALLBACK_PATH = '/auth/google/callback'
/** Where a browser goes to (re)link; the web app appends `?next=`. */
export const GOOGLE_START_PATH = '/auth/google/start'

/** KV (`SETTINGS`, "short-lived tokens") key prefixes. */
export const KV_STATE_PREFIX = 'google-oauth-state:'
export const KV_TOKEN_PREFIX = 'google-token:'
export const KV_LINK_PREFIX = 'google-link:'

/** A sign-in round trip takes seconds; ten minutes is generous and still short. */
export const STATE_TTL_SECONDS = 600
/** A token is treated as expired this long before Google's `expires_in` runs out. */
export const TOKEN_EXPIRY_MARGIN_SECONDS = 60
/** KV refuses an `expirationTtl` below 60 seconds. */
export const KV_MIN_TTL_SECONDS = 60
/**
 * How long the non-secret "this user linked Google once" marker lives, so an
 * expired token reads as `expired` rather than `unlinked`.
 * OPEN: 30 days chosen (OPEN_QUESTIONS.md "Google import" G3).
 */
export const LINK_MARKER_TTL_SECONDS = 30 * 24 * 60 * 60

export interface GoogleImportLimits {
  /**
   * Upper bound on the declared grid (Σ rowCount × columnCount of the grid
   * sheets). Checked from metadata before any cell is fetched.
   */
  maxDeclaredCells: number
  /**
   * Cells per `spreadsheets.get` grid request. Google: "we recommend a 2 MB
   * maximum payload"; 50,000 cells is about 40 bytes per declared cell, and
   * most declared cells of a real sheet are empty.
   */
  cellsPerRequest: number
  /** Decoded bytes of all Google responses of one import together (Worker memory: 128 MB). */
  maxResponseBytes: number
  /** A report larger than this is kept in R2 instead of D1 (D1: 2,000,000 bytes per value). */
  maxInlineReportBytes: number
  /** Per request to Google. Sheets stops processing a request after 180 s. */
  requestTimeoutMs: number
}

// OPEN: every number below needs calibrating against the real 7-sheet file and
// the phase 7 load test (OPEN_QUESTIONS.md "Google import" G5).
export const DEFAULT_LIMITS: GoogleImportLimits = {
  maxDeclaredCells: 500_000,
  cellsPerRequest: 50_000,
  maxResponseBytes: 20 * 1024 * 1024,
  maxInlineReportBytes: 1_000_000,
  requestTimeoutMs: 60_000,
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface GoogleImportOptions {
  /** Outbound fetch to Google. Tests inject a fake; nothing else should. */
  fetch?: FetchLike
  limits?: Partial<GoogleImportLimits>
}

export interface GoogleConfig {
  clientId: string
  clientSecret: string
  encryptionKey: string
}

/** The three settings the flow needs, or null when any is missing. */
export function googleConfig(env: Env): GoogleConfig | null {
  const e = env as GoogleImportEnv
  if (!e.GOOGLE_CLIENT_ID || !e.GOOGLE_CLIENT_SECRET || !e.TOKEN_ENCRYPTION_KEY) return null
  return { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET, encryptionKey: e.TOKEN_ENCRYPTION_KEY }
}

/**
 * `redirect_uri` "must exactly match one of the authorized redirect URIs"
 * (scheme, case and trailing slash included). It is built from the origin the
 * request arrived on, the same way at start and at callback, so the Google
 * console must list `https://<platform origin>/auth/google/callback`.
 * OPEN: the platform origin is spec §17-4 (OPEN_QUESTIONS.md "Google import" G2).
 */
export function redirectUri(requestUrl: string): string {
  return `${new URL(requestUrl).origin}${GOOGLE_CALLBACK_PATH}`
}
