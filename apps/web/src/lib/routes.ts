// Client-side routes (History API). Pure: no DOM access, so it is unit-tested.
//
//   /                       files screen (§12.1 item 1); `?q=` keeps the search
//   /workbooks/:id          workbook editor (§12.1 item 2)
//   /denied?r=<reason>      naf-auth's refusal page for document navigations

export type Route =
  | { name: 'files'; q: string }
  | { name: 'editor'; id: string }
  | { name: 'denied'; reason: string }
  | { name: 'notFound' }

const EDITOR = /^\/workbooks\/([^/]+)\/?$/

export function parseRoute(pathname: string, search = ''): Route {
  const params = new URLSearchParams(search)
  if (pathname === '/' || pathname === '') return { name: 'files', q: params.get('q') ?? '' }
  if (pathname === '/denied' || pathname === '/denied/') return { name: 'denied', reason: params.get('r') ?? '' }
  const match = EDITOR.exec(pathname)
  if (match?.[1]) {
    let id: string
    try {
      id = decodeURIComponent(match[1])
    } catch {
      return { name: 'notFound' }
    }
    if (id.trim()) return { name: 'editor', id }
  }
  return { name: 'notFound' }
}

export function pathFor(route: Route): string {
  switch (route.name) {
    case 'files': {
      const q = route.q.trim()
      return q ? `/?${new URLSearchParams({ q }).toString()}` : '/'
    }
    case 'editor':
      return `/workbooks/${encodeURIComponent(route.id)}`
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
