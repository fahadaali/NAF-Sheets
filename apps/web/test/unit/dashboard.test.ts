// The dashboard's pure helpers (src/dashboard/model.ts), its routes, and the
// palette rules shared with the API (packages/shared/src/api-dashboard.ts).

import { describe, expect, it } from 'vitest'
import type { DashboardSheet, WidgetGroup } from '@naf-sheets/shared'
import { APPEARANCE_TOKENS, CONTRAST_CHECKS, contrastRatio, contrastWarnings, normalizePalette } from '@naf-sheets/shared'
import { activityLabel, cellsHref, checkDraft, draftFromWidget, formatNumber, formatShare, groupLabel, moveWidget, newDraft, pieSlices } from '../../src/dashboard/model'
import { parseRoute, pathFor } from '../../src/lib/routes'
import { overridesOf } from '../../src/screens/AppearanceScreen'

const group = (label: string, value: number | null): WidgetGroup => ({ label, value, cells: 1, link: { sheetId: 's', range: 'A1' } })

const SHEETS: DashboardSheet[] = [
  {
    sheetId: 's-1',
    title: 'الميزانية',
    kind: 'plain',
    todos: 0,
    done: 0,
    open: 0,
    overdue: 0,
    completion: null,
    issues: 0,
    link: { sheetId: 's-1', range: 'A1' },
    columns: [
      { key: 'A', header: 'القسم' },
      { key: 'B', header: 'المبلغ' },
    ],
    headerRow: 1,
  },
]

describe('routes', () => {
  it('reads the older /workbooks/:id/dashboard, writes /workbooks/:id, and maps /admin/appearance both ways', () => {
    expect(parseRoute('/workbooks/wb-1/dashboard')).toEqual({ name: 'dashboard', id: 'wb-1' })
    expect(parseRoute('/workbooks/a%2Fb/dashboard/')).toEqual({ name: 'dashboard', id: 'a/b' })
    expect(pathFor({ name: 'dashboard', id: 'a/b' })).toBe('/workbooks/a%2Fb')
    expect(parseRoute('/admin/appearance')).toEqual({ name: 'appearance' })
    expect(pathFor({ name: 'appearance' })).toBe('/admin/appearance')
    expect(parseRoute('/workbooks/wb-1/dashboard/x')).toEqual({ name: 'notFound' })
  })

  it('links a figure to the editor’s deep link', () => {
    expect(cellsHref('wb-1', { sheetId: 'sheet-1', range: 'B2:B9' })).toBe('/workbooks/wb-1?sheet=sheet-1&range=B2%3AB9')
    expect(cellsHref('wb-1', { sheetId: 'sheet-1', range: 'A3' })).toBe('/workbooks/wb-1?sheet=sheet-1&range=A3')
    expect(parseRoute('/workbooks/wb-1', '?sheet=sheet-1&range=B2%3AB9')).toEqual({ name: 'editor', id: 'wb-1', target: { sheet: 'sheet-1', range: { startRow: 1, startColumn: 1, endRow: 8, endColumn: 1 } } })
  })
})

describe('numbers', () => {
  it('formats with Latin digits, grouping, at most two decimals', () => {
    expect(formatNumber(1250.456)).toBe('1,250.46')
    expect(formatNumber(48500)).toBe('48,500')
    expect(formatNumber(-3)).toBe('-3')
    expect(formatNumber(null)).toBe('—')
    expect(formatNumber(Number.NaN)).toBe('—')
    expect(formatShare(11 / 24)).toBe('46%')
    expect(formatShare(1.2)).toBe('100%')
    expect(formatShare(null)).toBe('—')
    expect(groupLabel('')).toBe('(فارغ)')
    expect(groupLabel('التسويق')).toBe('التسويق')
  })

  it('names sync_log actions in Arabic, with a fallback', () => {
    expect(activityLabel('create_todo')).toBe('أُنشئت مهمة')
    expect(activityLabel('webhook:whatever')).toBe('تغيير في المزامنة')
  })
})

describe('pie slices', () => {
  it('largest first, positive only; past the limit the rest become «أخرى» for sum and count', () => {
    const groups = [group('أ', 5), group('ب', 30), group('ج', 0), group('د', null), group('هـ', 12)]
    expect(pieSlices(groups, 'sum').slices.map((s) => [s.label, s.value])).toEqual([
      ['ب', 30],
      ['هـ', 12],
      ['أ', 5],
    ])
    const many = Array.from({ length: 11 }, (_, i) => group(`م${i}`, 11 - i))
    const sum = pieSlices(many, 'sum', 7)
    expect(sum.slices).toHaveLength(8)
    expect(sum.slices.at(-1)).toMatchObject({ label: 'أخرى', value: 4 + 3 + 2 + 1, other: true, link: null })
    const max = pieSlices(many, 'max', 7)
    expect(max.slices).toHaveLength(7)
    expect(max.hidden).toBe(4)
    // Exactly one past the limit: no «أخرى» of a single group.
    expect(pieSlices(many.slice(0, 8), 'sum', 7).slices.map((s) => s.other)).not.toContain(true)
  })
})

describe('ordering', () => {
  it('moves a widget one place, never past the ends', () => {
    expect(moveWidget(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c'])
    expect(moveWidget(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b'])
    expect(moveWidget(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c'])
    expect(moveWidget(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c'])
  })
})

describe('the widget form', () => {
  it('starts on the first sheet: its second column, grouped by its first, as bars', () => {
    expect(newDraft(SHEETS)).toMatchObject({ sheetId: 's-1', sourceKind: 'column', column: 'B', groupBy: 'A', display: 'bar', aggregation: 'count' })
  })

  it('builds the configuration and says what stops it', () => {
    const draft = { ...newDraft(SHEETS), title: '  الميزانية   حسب القسم ', aggregation: 'sum' as const }
    expect(checkDraft(draft)).toEqual({
      config: { title: 'الميزانية حسب القسم', sheetId: 's-1', source: { kind: 'column', column: 'B' }, aggregation: 'sum', groupBy: 'A', display: 'bar' },
      problems: [],
    })
    expect(checkDraft({ ...draft, title: ' ' }).problems).toEqual(['title'])
    // The preview needs no title.
    expect(checkDraft({ ...draft, title: '' }, { forPreview: true }).config).not.toBeNull()
    expect(checkDraft({ ...draft, groupBy: '', display: 'pie' }).problems).toEqual(['group'])
    expect(checkDraft({ ...draft, groupBy: '', display: 'kpi' }).config?.groupBy).toBeNull()
    expect(checkDraft({ ...draft, sourceKind: 'range', range: 'b2:b30' }).config?.source).toEqual({ kind: 'range', range: 'B2:B30' })
    expect(checkDraft({ ...draft, sourceKind: 'range', range: 'B2:' }).problems).toEqual(['range'])
    expect(checkDraft({ ...draft, sourceKind: 'range', range: '2B' }).problems).toEqual(['range'])
  })

  it('reads a stored widget back into the form', () => {
    const draft = draftFromWidget({ id: 'w', position: 0, updatedAt: '', title: 'ع', sheetId: 's-1', source: { kind: 'range', range: 'C2:C9' }, aggregation: 'max', groupBy: null, display: 'kpi' })
    expect(draft).toMatchObject({ sourceKind: 'range', range: 'C2:C9', column: '', groupBy: '', display: 'kpi' })
  })
})

describe('palette', () => {
  it('accepts #rrggbb only, for known names, lower-cased', () => {
    expect(normalizePalette({ accent: '#2F6F73', series3: '#5d8655' })).toEqual({ accent: '#2f6f73', series3: '#5d8655' })
    expect(normalizePalette({})).toEqual({})
    for (const bad of [{ accent: '#fff' }, { accent: 'teal' }, { accent: '#2f6f7' }, { nope: '#ffffff' }, { accent: null }, [], null, 'x']) expect(normalizePalette(bad)).toBeNull()
  })

  it('checks text at 4.5:1 and chart series at 3:1 on the surface', () => {
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5)
    expect(CONTRAST_CHECKS.filter((c) => c.use === 'graphic')).toHaveLength(8)
    expect(contrastWarnings({ series1: '#cccccc', surface: '#ffffff' })).toEqual([{ foreground: 'series1', background: 'surface', ratio: 1.61, minimum: 3 }])
    expect(contrastWarnings({ series1: '#767676', surface: '#ffffff' })).toEqual([])
    // A pair with one side missing is not judged.
    expect(contrastWarnings({ text: '#cccccc' })).toEqual([])
  })

  it('every editable name maps to one custom property', () => {
    const properties = Object.values(APPEARANCE_TOKENS)
    expect(new Set(properties).size).toBe(properties.length)
    for (const p of properties) expect(p).toMatch(/^--(color|chart)-/)
  })

  it('stores only what differs from the defaults', () => {
    expect(overridesOf({ accent: '#2F6F73', text: '#111111', page: 'bad' }, { accent: '#2f6f73', text: '#1f2a2e', page: '#f6f7f5' })).toEqual({ text: '#111111' })
  })
})
