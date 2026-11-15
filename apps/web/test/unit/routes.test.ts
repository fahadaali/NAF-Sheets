import { describe, expect, it } from 'vitest'
import { isPlainLeftClick, parseRoute, pathFor } from '../../src/lib/routes'
import type { Route } from '../../src/lib/routes'

describe('parseRoute', () => {
  it('opens the station on its links, and maps its screens', () => {
    expect(parseRoute('/')).toEqual({ name: 'stationLinks' })
    expect(parseRoute('/links/new')).toEqual({ name: 'stationNew' })
    expect(parseRoute('/links/abc-1')).toEqual({ name: 'stationLink', id: 'abc-1' })
    expect(parseRoute('/links/a%2Fb/')).toEqual({ name: 'stationLink', id: 'a/b' })
    // The alert email's links (docs/station-plan.md §6.2).
    expect(parseRoute('/names', `?name=${encodeURIComponent('عمر العمار')}&suggest=52761043`)).toEqual({ name: 'stationNames', focusName: 'عمر العمار', suggest: 52761043 })
    expect(parseRoute('/names', '?suggest=x&name=%20')).toEqual({ name: 'stationNames' })
  })

  it('maps settings, admin screens and naf-auth refusals', () => {
    expect(parseRoute('/settings')).toEqual({ name: 'settings' })
    expect(parseRoute('/admin/members/')).toEqual({ name: 'members' })
    expect(parseRoute('/admin/appearance')).toEqual({ name: 'appearance' })
    expect(parseRoute('/denied', '?r=inactive')).toEqual({ name: 'denied', reason: 'inactive' })
  })

  it('sends the removed editor’s addresses to «not found»', () => {
    for (const path of ['/files', '/workbooks/wb-1', '/workbooks/wb-1/link', '/admin/templates', '/admin/sync-health']) {
      expect(parseRoute(path), path).toEqual({ name: 'notFound' })
    }
  })
})

describe('pathFor', () => {
  it('round-trips through parseRoute', () => {
    const routes: Route[] = [
      { name: 'stationLinks' },
      { name: 'stationNew' },
      { name: 'stationLink', id: 'a/b c' },
      { name: 'stationNames' },
      { name: 'stationNames', focusName: 'مسند المحمدي', suggest: 7 },
      { name: 'settings' },
      { name: 'members' },
      { name: 'appearance' },
      { name: 'denied', reason: 'inactive' },
    ]
    for (const route of routes) {
      const path = pathFor(route)
      const [pathname, search] = path.split('?')
      expect(parseRoute(pathname!, search ? `?${search}` : ''), path).toEqual(route)
    }
  })
})

describe('isPlainLeftClick', () => {
  const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false }
  it('takes over only an unmodified primary click', () => {
    expect(isPlainLeftClick(click)).toBe(true)
    expect(isPlainLeftClick({ ...click, button: 1 })).toBe(false)
    expect(isPlainLeftClick({ ...click, ctrlKey: true })).toBe(false)
    expect(isPlainLeftClick({ ...click, defaultPrevented: true })).toBe(false)
  })
})
