// Minimal History API router: `navigate()` and `useRoute()`, plus a `Link`
// that keeps normal browser behaviour for modified clicks (new tab, etc.).

import { useEffect, useState } from 'react'
import type { AnchorHTMLAttributes, MouseEvent } from 'react'
import { isPlainLeftClick, parseRoute } from './routes'
import type { Route } from './routes'

const NAVIGATE_EVENT = 'naf:navigate'

type Guard = () => boolean
let leaveGuard: Guard | null = null

/**
 * While set, every in-app navigation asks the guard first; it returns false to
 * stay. The editor uses it when changes could not be saved.
 */
export function setLeaveGuard(guard: Guard | null): void {
  leaveGuard = guard
}

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  const current = window.location.pathname + window.location.search
  if (path === current) return
  if (leaveGuard && !options.replace && !leaveGuard()) return
  if (options.replace) window.history.replaceState(null, '', path)
  else window.history.pushState(null, '', path)
  window.dispatchEvent(new Event(NAVIGATE_EVENT))
}

const currentRoute = (): Route => parseRoute(window.location.pathname, window.location.search)

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(currentRoute)
  useEffect(() => {
    const update = () => setRoute(currentRoute())
    window.addEventListener('popstate', update)
    window.addEventListener(NAVIGATE_EVENT, update)
    return () => {
      window.removeEventListener('popstate', update)
      window.removeEventListener(NAVIGATE_EVENT, update)
    }
  }, [])
  return route
}

export function Link({ href, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e)
    if (!isPlainLeftClick(e) || rest.target) return
    e.preventDefault()
    navigate(href)
  }
  return <a href={href} onClick={handle} {...rest} />
}
