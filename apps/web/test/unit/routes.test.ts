import { describe, expect, it } from 'vitest'
import { isPlainLeftClick, parseRoute, pathFor } from '../../src/lib/routes'
import type { Route } from '../../src/lib/routes'

describe('parseRoute', () => {
  it('maps the files screen with its search', () => {
    expect(parseRoute('/')).toEqual({ name: 'files', q: '' })
    expect(parseRoute('/', '?q=%D8%AE%D8%B7%D8%A9')).toEqual({ name: 'files', q: 'خطة' })
  })

  it('opens a workbook on its first tab, the dashboard, and decodes the id', () => {
    expect(parseRoute('/workbooks/wb-1')).toEqual({ name: 'dashboard', id: 'wb-1' })
    expect(parseRoute('/workbooks/wb-1/')).toEqual({ name: 'dashboard', id: 'wb-1' })
    expect(parseRoute('/workbooks/a%2Fb')).toEqual({ name: 'dashboard', id: 'a/b' })
    // Links that name no place (files list, import report, wizard) land there too.
    expect(pathFor({ name: 'editor', id: 'wb-1' })).toBe('/workbooks/wb-1')
  })

  it('maps naf-auth refusals', () => {
    expect(parseRoute('/denied', '?r=inactive')).toEqual({ name: 'denied', reason: 'inactive' })
    expect(parseRoute('/denied')).toEqual({ name: 'denied', reason: '' })
  })

  it('treats anything else as not found', () => {
    for (const path of ['/workbooks', '/workbooks/', '/workbooks/a/b', '/workbooks/%E0%A4%A', '/workbooks/%20', '/settings/x', '/admin', '/workbooks/a/link/x', '/workbooks/%20/link']) {
      expect(parseRoute(path), path).toEqual({ name: 'notFound' })
    }
  })
})

describe('parseRoute — wave 2 screens', () => {
  it('maps the import report, the linking wizard, settings and people matching', () => {
    expect(parseRoute('/workbooks/wb-1/import-report')).toEqual({ name: 'importReport', id: 'wb-1' })
    expect(parseRoute('/workbooks/a%2Fb/link/')).toEqual({ name: 'linkWizard', id: 'a/b' })
    expect(parseRoute('/settings')).toEqual({ name: 'settings' })
    expect(parseRoute('/admin/people-matches')).toEqual({ name: 'peopleMatches' })
  })

  it('maps the admin screens of phase 7', () => {
    expect(parseRoute('/admin/sync-health')).toEqual({ name: 'syncHealth' })
    expect(parseRoute('/admin/templates/')).toEqual({ name: 'templates' })
    expect(parseRoute('/admin/api-tokens')).toEqual({ name: 'apiTokens' })
    expect(parseRoute('/admin/other')).toEqual({ name: 'notFound' })
  })

  it('reads the editor target: a sheet, and a range when it is valid A1', () => {
    expect(parseRoute('/workbooks/wb-1', '?sheet=s-2&range=B4%3AC10')).toEqual({
      name: 'editor',
      id: 'wb-1',
      target: { sheet: 's-2', range: { startRow: 3, startColumn: 1, endRow: 9, endColumn: 2 } },
    })
    expect(parseRoute('/workbooks/wb-1', '?sheet=s-2')).toEqual({ name: 'editor', id: 'wb-1', target: { sheet: 's-2', range: null } })
    // An unreadable range still opens the sheet; a range without a sheet is ignored.
    expect(parseRoute('/workbooks/wb-1', '?sheet=s-2&range=b4')).toEqual({ name: 'editor', id: 'wb-1', target: { sheet: 's-2', range: null } })
    expect(parseRoute('/workbooks/wb-1', '?range=B4')).toEqual({ name: 'dashboard', id: 'wb-1' })
    expect(parseRoute('/workbooks/wb-1', '?sheet=%20')).toEqual({ name: 'dashboard', id: 'wb-1' })
  })

  it('reads `import` on the files screen only when it looks like a spreadsheet id', () => {
    expect(parseRoute('/', '?import=1AbC_d-9')).toEqual({ name: 'files', q: '', importSource: '1AbC_d-9' })
    expect(parseRoute('/', '?import=https%3A%2F%2Fevil.example')).toEqual({ name: 'files', q: '' })
    expect(parseRoute('/', '?import=')).toEqual({ name: 'files', q: '' })
  })
})

describe('pathFor', () => {
  it('round-trips through parseRoute', () => {
    const routes: Route[] = [
      { name: 'files', q: '' },
      { name: 'files', q: 'خطة الربع الأول' },
      { name: 'files', q: '', importSource: '1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-abcd' },
      { name: 'dashboard', id: 'wb-1' },
      { name: 'dashboard', id: 'a/b c' },
      { name: 'editor', id: 'wb-1', target: { sheet: 'sheet 2/ب', range: { startRow: 0, startColumn: 26, endRow: 4, endColumn: 27 } } },
      { name: 'editor', id: 'wb-1', target: { sheet: 's-1', range: null } },
      { name: 'importReport', id: 'wb 1' },
      { name: 'linkWizard', id: 'wb-1' },
      { name: 'settings' },
      { name: 'peopleMatches' },
      { name: 'syncHealth' },
      { name: 'templates' },
      { name: 'apiTokens' },
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
