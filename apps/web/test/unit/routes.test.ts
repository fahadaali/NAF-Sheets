import { describe, expect, it } from 'vitest'
import { isPlainLeftClick, parseRoute, pathFor } from '../../src/lib/routes'
import type { Route } from '../../src/lib/routes'

describe('parseRoute', () => {
  it('maps the files screen with its search', () => {
    expect(parseRoute('/')).toEqual({ name: 'files', q: '' })
    expect(parseRoute('/', '?q=%D8%AE%D8%B7%D8%A9')).toEqual({ name: 'files', q: 'خطة' })
  })

  it('maps the editor and decodes the id', () => {
    expect(parseRoute('/workbooks/wb-1')).toEqual({ name: 'editor', id: 'wb-1' })
    expect(parseRoute('/workbooks/wb-1/')).toEqual({ name: 'editor', id: 'wb-1' })
    expect(parseRoute('/workbooks/a%2Fb')).toEqual({ name: 'editor', id: 'a/b' })
  })

  it('maps naf-auth refusals', () => {
    expect(parseRoute('/denied', '?r=inactive')).toEqual({ name: 'denied', reason: 'inactive' })
    expect(parseRoute('/denied')).toEqual({ name: 'denied', reason: '' })
  })

  it('treats anything else as not found', () => {
    for (const path of ['/workbooks', '/workbooks/', '/workbooks/a/b', '/workbooks/%E0%A4%A', '/workbooks/%20', '/settings']) {
      expect(parseRoute(path), path).toEqual({ name: 'notFound' })
    }
  })
})

describe('pathFor', () => {
  it('round-trips through parseRoute', () => {
    const routes: Route[] = [
      { name: 'files', q: '' },
      { name: 'files', q: 'خطة الربع الأول' },
      { name: 'editor', id: 'wb-1' },
      { name: 'editor', id: 'a/b c' },
      { name: 'denied', reason: 'not_member' },
    ]
    for (const route of routes) {
      const path = pathFor(route)
      const [pathname, search = ''] = path.split('?')
      expect(parseRoute(pathname ?? '', search ? `?${search}` : ''), path).toEqual(route)
    }
  })

  it('drops an empty or blank search from the address', () => {
    expect(pathFor({ name: 'files', q: '   ' })).toBe('/')
    expect(pathFor({ name: 'files', q: ' خطة ' })).toBe(`/?q=${encodeURIComponent('خطة').replace(/%20/g, '+')}`)
  })
})

describe('isPlainLeftClick', () => {
  const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false }
  it('takes over only an unmodified primary click', () => {
    expect(isPlainLeftClick(click)).toBe(true)
    expect(isPlainLeftClick({ ...click, button: 1 })).toBe(false)
    expect(isPlainLeftClick({ ...click, ctrlKey: true })).toBe(false)
    expect(isPlainLeftClick({ ...click, metaKey: true })).toBe(false)
    expect(isPlainLeftClick({ ...click, shiftKey: true })).toBe(false)
    expect(isPlainLeftClick({ ...click, defaultPrevented: true })).toBe(false)
  })
})
