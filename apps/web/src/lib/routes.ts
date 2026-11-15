// Client-side routes (History API). Pure: no DOM access, so it is unit-tested.
//
//   /                                   the station's links (docs/station-plan.md §6)
//   /links/new, /links/:id              new link, one link
//   /names?name=&suggest=               name matching (alert emails link here)
//   /files                              files screen (§12.1 item 1); `?q=` keeps the search;
//                                       `?import=<spreadsheet id>` reopens «ملف جديد» on the
//                                       Google Sheets option after Google's consent (§7.2)
//   /workbooks/:id                      workbook editor (§12.1 item 2), opened on its first tab,
//                                       the dashboard «اللوحة» (owner, 2026-11-11);
//                                       `?sheet=<univer sheet id>&range=B4:C10` opens a sheet and selects a place
//   /workbooks/:id/dashboard            older address of the dashboard tab; still read, never written
//   /workbooks/:id/import-report        import report (§7.2, §12.1 item 7)
//   /workbooks/:id/link                 linking wizard (§7.3), full screen
//   /settings                           the user's settings: Basecamp account (§3), admin entries
//   /admin/members                      platform members: role and active state, admins only (§3)
//   /admin/people-matches               naf-id members ↔ Basecamp people, admins only (§3);
//                                       `#match-<user id>` focuses that member's row
//   /admin/sync-health                  sync health report, admins only (§9.4, phase 7)
//   /admin/templates                    templates, admins only (§7.1, phase 7)
//   /admin/api-tokens                   service tokens of the internal API, admins only (§13)
//   /admin/appearance                   the palette («المظهر»), admins only
//   /denied?r=<reason>                  naf-auth's refusal page for document navigations

import { parseA1Range, rangeToA1 } from './cell-target'
import type { EditorTarget } from './cell-target'

export type Route =
  | { name: 'stationLinks' }
  | { name: 'stationNew' }
  | { name: 'stationLink'; id: string }
  | { name: 'stationNames'; focusName?: string; suggest?: number }
  | { name: 'files'; q: string; importSource?: string }
  | { name: 'editor'; id: string; target?: EditorTarget }
  | { name: 'dashboard'; id: string }
  | { name: 'importReport'; id: string }
  | { name: 'linkWizard'; id: string }
  | { name: 'settings' }
  | { name: 'members' }
  | { name: 'peopleMatches' }
  | { name: 'syncHealth' }
  | { name: 'templates' }
  | { name: 'apiTokens' }
  | { name: 'appearance' }
  | { name: 'denied'; reason: string }
  | { name: 'notFound' }

const WORKBOOK = /^\/workbooks\/([^/]+)(?:\/(import-report|link|dashboard))?\/?$/
const IMPORT_ID = /^[A-Za-z0-9_-]{1,128}$/

function decodeId(segment: string): string | null {
  let id: string
  try {
    id = decodeURIComponent(segment)
  } catch {
    return null
  }
  return id.trim() ? id : null
}

/** `?sheet=&range=`: a sheet id is required; an unreadable range is dropped (the sheet is still opened). */
function parseTarget(params: URLSearchParams): EditorTarget | undefined {
  const sheet = params.get('sheet')
  if (!sheet || !sheet.trim()) return undefined
  const rangeText = params.get('range')
  return { sheet, range: rangeText ? parseA1Range(rangeText) : null }
}

export function parseRoute(pathname: string, search = ''): Route {
  const params = new URLSearchParams(search)
  // The station (docs/station-plan.md §6): the platform's home is its links.
  if (pathname === '/' || pathname === '') return { name: 'stationLinks' }
  if (pathname === '/links/new' || pathname === '/links/new/') return { name: 'stationNew' }
  const station = /^\/links\/([^/]+)\/?$/.exec(pathname)
  if (station?.[1]) {
    const id = decodeId(station[1])
    return id === null ? { name: 'notFound' } : { name: 'stationLink', id }
  }
  if (pathname === '/names' || pathname === '/names/') {
    const route: Route = { name: 'stationNames' }
    const focus = params.get('name')
    if (focus && focus.trim()) route.focusName = focus.trim()
    const suggest = Number(params.get('suggest'))
    if (Number.isInteger(suggest) && suggest > 0) route.suggest = suggest
    return route
  }
  if (pathname === '/files' || pathname === '/files/') {
    const route: Route = { name: 'files', q: params.get('q') ?? '' }
    const importSource = params.get('import')
    if (importSource && IMPORT_ID.test(importSource)) route.importSource = importSource
    return route
  }
  if (pathname === '/denied' || pathname === '/denied/') return { name: 'denied', reason: params.get('r') ?? '' }
  if (pathname === '/settings' || pathname === '/settings/') return { name: 'settings' }
  if (pathname === '/admin/members' || pathname === '/admin/members/') return { name: 'members' }
  if (pathname === '/admin/people-matches' || pathname === '/admin/people-matches/') return { name: 'peopleMatches' }
  if (pathname === '/admin/sync-health' || pathname === '/admin/sync-health/') return { name: 'syncHealth' }
  if (pathname === '/admin/templates' || pathname === '/admin/templates/') return { name: 'templates' }
  if (pathname === '/admin/api-tokens' || pathname === '/admin/api-tokens/') return { name: 'apiTokens' }
  if (pathname === '/admin/appearance' || pathname === '/admin/appearance/') return { name: 'appearance' }
  const match = WORKBOOK.exec(pathname)
  if (match?.[1]) {
    const id = decodeId(match[1])
    if (id === null) return { name: 'notFound' }
    if (match[2] === 'import-report') return { name: 'importReport', id }
    if (match[2] === 'link') return { name: 'linkWizard', id }
    if (match[2] === 'dashboard') return { name: 'dashboard', id }
    // No place asked for: the first tab, «اللوحة».
    const target = parseTarget(params)
    return target ? { name: 'editor', id, target } : { name: 'dashboard', id }
  }
  return { name: 'notFound' }
}

export function pathFor(route: Route): string {
  switch (route.name) {
    case 'files': {
      const params = new URLSearchParams()
      const q = route.q.trim()
      if (q) params.set('q', q)
      if (route.importSource) params.set('import', route.importSource)
      const search = params.toString()
      return search ? `/files?${search}` : '/files'
    }
    case 'stationLinks':
      return '/'
    case 'stationNew':
      return '/links/new'
    case 'stationLink':
      return `/links/${encodeURIComponent(route.id)}`
    case 'stationNames': {
      const params = new URLSearchParams()
      if (route.focusName) params.set('name', route.focusName)
      if (route.suggest) params.set('suggest', String(route.suggest))
      const search = params.toString()
      return search ? `/names?${search}` : '/names'
    }
    case 'editor': {
      const base = `/workbooks/${encodeURIComponent(route.id)}`
      if (!route.target) return base
      const params = new URLSearchParams({ sheet: route.target.sheet })
      if (route.target.range) params.set('range', rangeToA1(route.target.range))
      return `${base}?${params.toString()}`
    }
    case 'dashboard':
      return `/workbooks/${encodeURIComponent(route.id)}`
    case 'importReport':
      return `/workbooks/${encodeURIComponent(route.id)}/import-report`
    case 'linkWizard':
      return `/workbooks/${encodeURIComponent(route.id)}/link`
    case 'settings':
      return '/settings'
    case 'members':
      return '/admin/members'
    case 'peopleMatches':
      return '/admin/people-matches'
    case 'syncHealth':
      return '/admin/sync-health'
    case 'templates':
      return '/admin/templates'
    case 'apiTokens':
      return '/admin/api-tokens'
    case 'appearance':
      return '/admin/appearance'
    case 'denied':
      return route.reason ? `/denied?${new URLSearchParams({ r: route.reason }).toString()}` : '/denied'
    case 'notFound':
      return '/'
  }
}

/** A plain primary-button click with no modifier: the only click the SPA takes over from the browser. */
export function isPlainLeftClick(e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean }): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.defaultPrevented
}
