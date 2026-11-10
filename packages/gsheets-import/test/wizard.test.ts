// Mapping-wizard helpers (spec §7.3 steps 3–6) on hand-made grids and on the
// converted fixtures.

import { describe, expect, it } from 'vitest'
import {
  analyzeStatusColumn,
  COLUMN_SYNONYMS,
  convertSpreadsheet,
  detectHeaderRow,
  detectHierarchy,
  isCompletedValue,
  latinDigits,
  matchHeader,
  normalizeLabel,
  suggestColumnMapping,
  textGridFromWorksheet,
} from '../src'
import { englishLtr } from './fixtures/english-ltr'
import { nafCommsPlan } from './fixtures/naf-comms-plan'

const tasksGrid = textGridFromWorksheet(convertSpreadsheet(nafCommsPlan).workbook.sheets['sheet-0'] ?? {})
const englishGrid = textGridFromWorksheet(convertSpreadsheet(englishLtr).workbook.sheets['sheet-42'] ?? {})

describe('normalisation', () => {
  it('folds diacritics, tatweel, alef forms, case, punctuation and spacing', () => {
    expect(normalizeLabel('  تاريخُ  الإنجاز؟ ')).toBe('تاريخ الانجاز')
    expect(normalizeLabel('المـــهمة')).toBe('المهمة')
    expect(normalizeLabel('Due-Date')).toBe('due date')
  })

  it('does not fold taa marbuta, alef maqsura or the article (OPEN §10)', () => {
    expect(normalizeLabel('مهمة')).not.toBe(normalizeLabel('المهمة'))
  })

  it('converts Arabic-Indic digits', () => {
    expect(latinDigits('١٫٢')).toBe('1.2')
    expect(latinDigits('۳')).toBe('3')
  })
})

describe('header row (step 3)', () => {
  it('finds the header by synonyms, past a title row', () => {
    expect(detectHeaderRow(englishGrid)).toEqual({ row: 1, reason: 'synonyms', matchedColumns: 4 })
    expect(detectHeaderRow(tasksGrid)).toMatchObject({ row: 0, reason: 'synonyms' })
  })

  it('defaults to row 1 when no row has two synonyms', () => {
    // "تقرير الحالة" contains الحالة (one partial match): too weak to call it a header row.
    expect(detectHeaderRow([['تقرير الحالة'], ['أ', 'ب']])).toEqual({ row: 0, reason: 'default', matchedColumns: 1 })
    expect(detectHeaderRow([])).toEqual({ row: 0, reason: 'default', matchedColumns: 0 })
  })
})

describe('column mapping (step 4)', () => {
  it('maps every synonym the spec lists to its field', () => {
    for (const [field, synonyms] of Object.entries(COLUMN_SYNONYMS)) {
      for (const synonym of synonyms) {
        expect(matchHeader(synonym)[0], synonym).toMatchObject({ field, match: 'exact' })
      }
    }
  })

  it('suggests the mapping of the Arabic task sheet', () => {
    const suggestions = suggestColumnMapping(tasksGrid[0] ?? [])
    expect(suggestions.map((s) => [s.header, s.field, s.match])).toEqual([
      ['#', 'free', 'none'],
      ['المهمة', 'title', 'exact'],
      ['المسؤول', 'assignees', 'exact'],
      ['تاريخ البدء', 'starts_on', 'exact'],
      ['تاريخ الاستحقاق', 'due_on', 'exact'],
      ['الحالة', 'completed', 'exact'],
      ['ملاحظات', 'notes', 'exact'],
      ['التكلفة', 'free', 'none'],
      ['مراجعة', 'free', 'none'],
    ])
    expect(suggestions.every((s) => s.appendToDescription === false)).toBe(true)
  })

  it('uses whole-word partial matches when unambiguous', () => {
    const suggestions = suggestColumnMapping(englishGrid[1] ?? [])
    expect(suggestions.map((s) => [s.header, s.field, s.match])).toEqual([
      ['Task', 'title', 'exact'],
      ['Owner', 'assignees', 'exact'],
      ['Due date', 'due_on', 'partial'],
      ['Done', 'completed', 'exact'],
      ['Budget notes', 'free', 'none'],
    ])
  })

  it('leaves ambiguous headers free and gives each field to one column', () => {
    const suggestions = suggestColumnMapping(['Task owner', 'الحالة', 'Status', 'المهمة', 'تاريخ الانجاز'])
    expect(suggestions.map((s) => s.field)).toEqual(['free', 'completed', 'free', 'title', 'due_on'])
    expect(suggestions[0]?.alternatives.sort()).toEqual(['assignees', 'title'])
    expect(suggestions[2]?.alternatives).toEqual(['completed'])
  })
})

describe('hierarchy (step 5)', () => {
  it('reads a numbering column (1, 1.1, 1.2, 2, 2.1)', () => {
    const result = detectHierarchy(tasksGrid, { headerRow: 0, titleColumn: 1 })
    expect(result.source).toBe('numbering')
    expect(result.numberingColumn).toBe(0)
    expect(result.rows).toEqual([
      { row: 1, level: 0, parentRow: null },
      { row: 2, level: 1, parentRow: 1 },
      { row: 3, level: 1, parentRow: 1 },
      { row: 4, level: 0, parentRow: null },
      { row: 5, level: 1, parentRow: 4 },
      { row: 6, level: 0, parentRow: null }, // "الإجمالي" has no number
    ])
    expect(result.warnings).toEqual([])
  })

  it('reads leading indentation', () => {
    const result = detectHierarchy(englishGrid, { headerRow: 1, titleColumn: 0 })
    expect(result.source).toBe('indentation')
    expect(result.rows.map((r) => [r.row, r.level, r.parentRow])).toEqual([
      [2, 0, null],
      [3, 1, 2],
      [4, 1, 2],
      [5, 0, null],
      [6, 1, 5],
    ])
  })

  it('flags levels Basecamp cannot hold and subtasks without a parent', () => {
    const grid = [['#', 'المهمة'], ['1.1', 'يتيمة'], ['1', 'أ'], ['1.1', 'ب'], ['1.1.1', 'ج'], ['٢', 'د'], ['٢٫١', 'هـ']]
    const result = detectHierarchy(grid, { headerRow: 0, titleColumn: 1 })
    expect(result.rows.map((r) => [r.row, r.level, r.parentRow])).toEqual([
      [1, 0, null],
      [2, 0, null],
      [3, 1, 2],
      [4, 1, 2],
      [5, 0, null],
      [6, 1, 5],
    ])
    expect(result.warnings).toEqual([
      { row: 1, kind: 'orphan' },
      { row: 4, kind: 'too_deep' },
    ])
  })

  it('treats every row as a main task when there is no numbering or indentation', () => {
    const result = detectHierarchy([['المهمة'], ['أ'], ['ب']], { headerRow: 0, titleColumn: 0 })
    expect(result).toEqual({ source: 'none', numberingColumn: null, rows: [{ row: 1, level: 0, parentRow: null }, { row: 2, level: 0, parentRow: null }], warnings: [] })
  })

  it('does not take a column of plain integers or mixed values for numbering', () => {
    const grid = [['#', 'المهمة'], ['1', 'أ'], ['2', 'ب'], ['x', 'ج']]
    expect(detectHierarchy(grid, { headerRow: 0, titleColumn: 1 }).source).toBe('none')
  })
})

describe('status values (step 6)', () => {
  it('analyses a text status column and suggests the completed value', () => {
    const values = tasksGrid.slice(1, 6).map((row) => row[5] ?? '')
    expect(analyzeStatusColumn(values)).toEqual({
      kind: 'text',
      distinct: [
        { value: 'منجز', count: 2 },
        { value: 'قيد التنفيذ', count: 1 },
        { value: 'متأخر', count: 2 },
      ],
      suggestedCompleted: ['منجز'],
    })
  })

  it('recognises a TRUE/FALSE column', () => {
    const values = englishGrid.slice(2).map((row) => row[3] ?? '')
    expect(analyzeStatusColumn(values)).toMatchObject({ kind: 'boolean', suggestedCompleted: ['TRUE'] })
    expect(analyzeStatusColumn(['', ' '])).toEqual({ kind: 'empty', distinct: [], suggestedCompleted: [] })
  })

  it('tells completed values apart after normalisation, leaving the others', () => {
    expect(isCompletedValue(' منجز ', ['منجز'])).toBe(true)
    expect(isCompletedValue('done', ['Done'])).toBe(true)
    expect(isCompletedValue('قيد التنفيذ', ['منجز'])).toBe(false)
    expect(isCompletedValue('', ['منجز'])).toBe(false)
  })
})

describe('text grid', () => {
  it('reads values, booleans and rich text from a converted sheet, keeping line breaks', () => {
    expect(tasksGrid[1]?.slice(0, 3)).toEqual(['1', 'حملة اليوم الوطني', 'سارة العتيبي'])
    expect(tasksGrid[1]?.[8]).toBe('TRUE')
    expect(tasksGrid[3]?.[6]).toBe('المسودة جاهزة\nبانتظار الاعتماد')
    expect(englishGrid[3]?.[0]).toBe('  Draft')
  })
})
