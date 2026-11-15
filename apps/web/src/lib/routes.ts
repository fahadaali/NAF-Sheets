// Client-side routes (History API). Pure: no DOM access, so it is unit-tested.
//
//   /                          the station's links (docs/station-plan.md §6)
//   /links/new                 a new link
//   /links/:id                 one link
//   /names?name=&suggest=      name matching (the alert emails link here, §6.2)
//   /settings                  settings: admin entries
//   /admin/members             platform members: role and active state, admins only (§3)
//   /admin/appearance          the palette «المظهر», admins only
//   /denied?r=<reason>         naf-auth's refusal page for document navigations

export type Route =
  | { name: 'stationLinks' }
  | { name: 'stationNew' }
  | { name: 'stationLink'; id: string }
  | { name: 'stationNames'; focusName?: string; suggest?: number }
  | { name: 'settings' }
  | { name: 'members' }
  | { name: 'appearance' }
  | { name: 'denied'; reason: string }
  | { name: 'notFound' }

function decodeId(segment: string): string | null {
  let id: string
  try {
    id = decodeURIComponent(segment)
  } catch {
    return null
  }
  return id.trim() ? id : null
}

const same = (pathname: string, path: string): boolean => pathname === path || pathname === `${path}/`

export function parseRoute(pathname: string, search = ''): Route {
  const params = new URLSearchParams(search)
  if (pathname === '/' || pathname === '') return { name: 'stationLinks' }
  if (same(pathname, '/links/new')) return { name: 'stationNew' }
  const link = /^\/links\/([^/]+)\/?$/.exec(pathname)
  if (link?.[1]) {
    const id = decodeId(link[1])
    return id === null ? { name: 'notFound' } : { name: 'stationLink', id }
  }
  if (same(pathname, '/names')) {
    const route: Route = { name: 'stationNames' }
    const focus = params.get('name')
    if (focus && focus.trim()) route.focusName = focus.trim()
    const suggest = Number(params.get('suggest'))
    if (Number.isInteger(suggest) && suggest > 0) route.suggest = suggest
    return route
  }
  if (same(pathname, '/denied')) return { name: 'denied', reason: params.get('r') ?? '' }
  if (same(pathname, '/settings')) return { name: 'settings' }
  if (same(pathname, '/admin/members')) return { name: 'members' }
  if (same(pathname, '/admin/appearance')) return { name: 'appearance' }
  return { name: 'notFound' }
}

export function pathFor(route: Route): string {
  switch (route.name) {
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
    case 'settings':
      return '/settings'
    case 'members':
      return '/admin/members'
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
