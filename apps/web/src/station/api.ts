// Client of /api/station (apps/api/src/station/routes.ts). Same rules as the
// app's client: same origin, Arabic messages from the API, 401 → sign in.

import { ApiRequestError, redirectToLogin, toApiRequestError } from '../lib/api'
import { t } from '../strings'

export type StationAlert =
  | { kind: 'name_unmapped'; linkId: string; linkTitle: string; tab: string; role: string; name: string; rows: number; rowNumbers?: number[]; suggestion?: { bcPersonId: number; personName: string; previousName: string } }
  | { kind: 'not_project_member'; linkId: string; linkTitle: string; personName: string; bcPersonId: number; projectName: string; rows: number }
  | { kind: 'rows_held'; linkId: string; linkTitle: string; tab: string; code: string; subject?: string; reason: string; rows: number; rowNumbers?: number[] }
  | { kind: 'roles_conflict'; linkId: string; linkTitle: string; tab: string; role: string; names: string[] }
  | { kind: 'tab_stopped'; linkId: string; linkTitle: string; tab: string; reason: string }
  | { kind: 'link_stopped'; linkId: string; linkTitle: string; reason: string }

export interface LinkSummary {
  id: string
  title: string
  spreadsheet_id: string
  bc_project_id: number
  state: 'active' | 'paused'
  last_sync_at: string | null
  last_error: string | null
  tabs: number
  problems: number
}

export interface InspectedTab {
  sheetId: number
  title: string
  linkable: boolean
  reason?: string
  todos?: number
  subtasks?: number
  held?: string[]
}

export interface Inspection {
  spreadsheetId: string
  title: string
  serviceAccount: string
  hasRolesTab: boolean
  tabs: InspectedTab[]
}

export interface LinkDetail {
  link: { id: string; title: string; spreadsheet_id: string; bc_project_id: number; roles_tab: string; state: 'active' | 'paused'; last_sync_at: string | null; last_error: string | null; created_at: string }
  /** The project in Basecamp; null until BASECAMP_ACCOUNT_ID is set. */
  projectUrl: string | null
  tabs: { google_sheet_id: number; title: string; bc_todolist_id: number | null }[]
  problems: { key: string; alert: StationAlert; firstSeen: string; emailedAt: string | null }[]
  /** Subtasks deleted from Basecamp for good, newest first (their snapshots are kept). */
  deleted: { id: number; title: string; dueOn: string | null; completed: boolean; deletedAt: string; restoredAt: string | null }[]
  log: { id: number; at: string; direction: 'to_basecamp' | 'to_sheet'; action: string; task_uid: string | null; detail_json: string | null }[]
}

export interface NamesResponse {
  names: { name: string; bc_person_id: number; source: 'auto' | 'manual'; updated_at: string }[]
  unmapped: Extract<StationAlert, { kind: 'name_unmapped' }>[]
  people: { id: number; name: string }[]
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

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
    response = await fetch(path, init)
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { name?: string }).name === 'AbortError') throw error
    throw new ApiRequestError(0, 'network_error', t.errors.network)
  }
  const text = await response.text().catch(() => '')
  let payload: unknown
  try {
    payload = text ? JSON.parse(text) : undefined
  } catch {
    payload = undefined
  }
  if (response.ok) return (payload ?? {}) as T
  if (response.status === 401) {
    const login = typeof payload === 'object' && payload !== null && typeof (payload as { login?: unknown }).login === 'string' ? (payload as { login: string }).login : undefined
    redirectToLogin(login)
  }
  throw toApiRequestError(response.status, payload)
}

const linkPath = (id: string) => `/api/station/links/${encodeURIComponent(id)}`

export interface StationStatus {
  basecamp: { status: string; personId: number | null; name: string | null } | null
  google: string | null
  email: boolean
}

export const stationApi = {
  status: (signal?: AbortSignal) => request<StationStatus>('GET', '/api/station/status', undefined, signal),
  links: (signal?: AbortSignal) => request<{ links: LinkSummary[] }>('GET', '/api/station/links', undefined, signal),
  inspect: (source: string, rolesTab: string, signal?: AbortSignal) =>
    request<Inspection>('GET', `/api/station/inspect?${new URLSearchParams({ source, rolesTab }).toString()}`, undefined, signal),
  projects: (signal?: AbortSignal) => request<{ projects: { id: number; name: string; todosetId: number | null }[] }>('GET', '/api/station/projects', undefined, signal),
  createLink: (body: { source: string; bcProjectId: number; tabs: number[]; rolesTab: string }) => request<{ id: string }>('POST', '/api/station/links', body),
  link: (id: string, signal?: AbortSignal) => request<LinkDetail>('GET', linkPath(id), undefined, signal),
  updateLink: (id: string, body: { state?: 'active' | 'paused'; rolesTab?: string }) => request<object>('PATCH', linkPath(id), body),
  deleteLink: (id: string) => request<object>('DELETE', linkPath(id)),
  syncNow: (id: string) => request<object>('POST', `${linkPath(id)}/sync`),
  restoreDeleted: (id: string, n: number) => request<object>('POST', `${linkPath(id)}/deleted/${n}/restore`),
  restoreConflict: (id: string, n: number) => request<object>('POST', `${linkPath(id)}/conflicts/${n}/restore`),
  names: (signal?: AbortSignal) => request<NamesResponse>('GET', '/api/station/names', undefined, signal),
  putName: (name: string, bcPersonId: number) => request<object>('PUT', '/api/station/names', { name, bcPersonId }),
  deleteName: (name: string) => request<object>('DELETE', `/api/station/names?${new URLSearchParams({ name }).toString()}`),
}
