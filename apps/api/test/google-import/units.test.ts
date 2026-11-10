// Pure parts of the Google import: source parsing, field masks, range planning.

import { describe, expect, it } from 'vitest'
import type { GsSpreadsheet } from '@naf-sheets/gsheets-import'
import { nafCommsPlan } from '../../../../packages/gsheets-import/test/fixtures/naf-comms-plan'
import { GRID_MASK, METADATA_MASK, serializeMask } from '../../src/google-import/fields'
import { nextWithError } from '../../src/google-import/oauth'
import { declaredCells, planGridRequests, spreadsheetUrl } from '../../src/google-import/sheets-client'
import { parseSpreadsheetSource } from '../../src/google-import/source'
import { parseA1, parseMask } from './google-fake'

const ID = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms'

describe('parseSpreadsheetSource', () => {
  it('accepts a bare id and the docs.google.com URL forms', () => {
    const accepted = [
      ID,
      `  ${ID}  `,
      `https://docs.google.com/spreadsheets/d/${ID}`,
      `https://docs.google.com/spreadsheets/d/${ID}/`,
      `https://docs.google.com/spreadsheets/d/${ID}/edit`,
      `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`,
      `https://docs.google.com/spreadsheets/d/${ID}/edit?gid=1234#gid=1234`,
      `https://docs.google.com/spreadsheets/d/${ID}/edit?usp=sharing`,
      `https://docs.google.com/spreadsheets/u/1/d/${ID}/edit`,
      `https://DOCS.google.com/spreadsheets/d/${ID}/htmlview`,
      `docs.google.com/spreadsheets/d/${ID}/edit`,
    ]
    for (const source of accepted) expect(parseSpreadsheetSource(source), source).toBe(ID)
  })

  it('refuses everything else', () => {
    const refused: unknown[] = [
      undefined,
      null,
      42,
      '',
      '   ',
      'hello',
      'short-id',
      `${ID}!`,
      `http://docs.google.com/spreadsheets/d/${ID}/edit`,
      `https://drive.google.com/file/d/${ID}/view`,
      `https://drive.google.com/open?id=${ID}`,
      `https://docs.google.com/document/d/${ID}/edit`,
      `https://docs.google.com/spreadsheets/d/e/2PACX-1vQabcdefghijklmnopqrstuvwxyz0123456789/pubhtml`,
      `https://docs.google.com.evil.sa/spreadsheets/d/${ID}/edit`,
      `https://evil.sa/https://docs.google.com/spreadsheets/d/${ID}`,
      `https://user@docs.google.com/spreadsheets/d/${ID}/edit`,
      `https://docs.google.com:8443/spreadsheets/d/${ID}/edit`,
      `javascript:alert(1)//docs.google.com/spreadsheets/d/${ID}`,
      `https://docs.google.com/spreadsheets/d/${'x'.repeat(201)}/edit`,
      `https://docs.google.com/spreadsheets/d/${ID}/edit`.padEnd(3000, 'a'),
    ]
    for (const source of refused) expect(parseSpreadsheetSource(source), String(source)).toBeNull()
  })
})

describe('field masks', () => {
  it('are written only in the documented form: dotted paths, one level of parentheses', () => {
    for (const mask of [METADATA_MASK, GRID_MASK]) {
      for (const part of mask.match(/[^,(]+(\([^)]*\))?/g) ?? []) {
        expect(part, part).toMatch(/^[A-Za-z]+(\.[A-Za-z]+)*(\([A-Za-z]+(,[A-Za-z]+)*\))?$/)
      }
      expect(() => parseMask(mask)).not.toThrow()
    }
  })

  it('pin the exact masks (a change here must be deliberate)', () => {
    expect(METADATA_MASK).toBe(
      'spreadsheetId,' +
        'properties(title,locale,iterativeCalculationSettings),properties.spreadsheetTheme.themeColors,' +
        'namedRanges(namedRangeId,name,range),' +
        'sheets.merges,' +
        'sheets.properties(sheetId,title,index,sheetType,hidden,tabColor,tabColorStyle,rightToLeft),' +
        'sheets.properties.gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount,hideGridlines),' +
        'sheets.conditionalFormats(ranges,booleanRule,gradientRule),' +
        'sheets.basicFilter(range,tableId,criteria,filterSpecs),' +
        'sheets.bandedRanges(range,rowProperties,columnProperties),' +
        'sheets.tables(name,range),' +
        'sheets.rowGroups.range(startIndex,endIndex),' +
        'sheets.columnGroups.range(startIndex,endIndex),' +
        'sheets.filterViews(filterViewId,title,range),' +
        'sheets.protectedRanges(protectedRangeId,description,range),' +
        'sheets.charts.chartId,sheets.charts.spec.title,sheets.charts.position.overlayPosition.anchorCell,' +
        'sheets.slicers.slicerId,sheets.slicers.spec.title,sheets.slicers.position.overlayPosition.anchorCell',
    )
    expect(GRID_MASK).toBe(
      'sheets.properties.sheetId,' +
        'sheets.data(startRow,startColumn),' +
        'sheets.data.rowMetadata(pixelSize,hiddenByUser),' +
        'sheets.data.columnMetadata(pixelSize,hiddenByUser),' +
        'sheets.data.rowData.values(userEnteredValue,effectiveValue,formattedValue,userEnteredFormat,hyperlink,note,textFormatRuns,dataValidation,pivotTable,dataSourceTable),' +
        'sheets.data.rowData.values.effectiveFormat.numberFormat,' +
        'sheets.data.rowData.values.chipRuns.chip.personProperties.email,' +
        'sheets.data.rowData.values.chipRuns.chip.richLinkProperties.uri',
    )
  })

  it('leave out comments, comment anchors and protected-range editors', () => {
    for (const mask of [METADATA_MASK, GRID_MASK]) {
      expect(mask).not.toMatch(/comment/i)
      expect(mask).not.toMatch(/editors/)
      expect(mask).not.toMatch(/developerMetadata/)
    }
  })

  it('serialises a tree into one parenthesised list per path', () => {
    expect(serializeMask({ a: true, b: { c: true, d: true }, e: { f: { g: true } } })).toBe('a,b(c,d),e.f.g')
  })
})

describe('spreadsheet URL', () => {
  it('carries fields, includeGridData and repeated ranges', () => {
    const url = new URL(spreadsheetUrl(ID, { fields: 'sheets.properties.sheetId', includeGridData: true, ranges: ["'المهام'!A1:J30", "'Q''s'!A1"] }))
    expect(url.origin + url.pathname).toBe(`https://sheets.googleapis.com/v4/spreadsheets/${ID}`)
    expect(url.searchParams.get('fields')).toBe('sheets.properties.sheetId')
    expect(url.searchParams.get('includeGridData')).toBe('true')
    expect(url.searchParams.getAll('ranges')).toEqual(["'المهام'!A1:J30", "'Q''s'!A1"])
  })
})

describe('planGridRequests', () => {
  const sheet = (sheetId: number, title: string, rowCount: number, columnCount: number, sheetType: 'GRID' | 'OBJECT' = 'GRID') => ({
    properties: { sheetId, title, sheetType, gridProperties: sheetType === 'GRID' ? { rowCount, columnCount } : undefined },
  })

  it('puts a small workbook in one request covering every grid sheet whole', () => {
    expect(planGridRequests(nafCommsPlan, 50_000)).toEqual([["'المهام'!A1:J100", "'الملخص'!A1:F50", "'القوائم'!A1:B20", "'تحليل'!A1:F30"]])
    expect(declaredCells(nafCommsPlan)).toBe(100 * 10 + 50 * 6 + 20 * 2 + 30 * 6)
  })

  it('cuts sheets into row bands within the cell budget and never splits a row', () => {
    const doc: GsSpreadsheet = { sheets: [sheet(1, 'كبيرة', 1000, 26), sheet(2, "Q's", 10, 3), sheet(3, 'chart', 0, 0, 'OBJECT')] }
    const plan = planGridRequests(doc, 10_000)
    // 10,000 / 26 = 384 rows per band.
    expect(plan).toEqual([["'كبيرة'!A1:Z384"], ["'كبيرة'!A385:Z768"], ["'كبيرة'!A769:Z1000", "'Q''s'!A1:C10"]])
    for (const request of plan) {
      const cells = request.map(parseA1).reduce((n, r) => n + (r.endRow - r.startRow + 1) * (r.endColumn - r.startColumn + 1), 0)
      expect(cells).toBeLessThanOrEqual(10_000)
    }
  })

  it('takes one row per band when a single row is wider than the budget', () => {
    expect(planGridRequests({ sheets: [sheet(1, 'wide', 2, 30)] }, 10)).toEqual([["'wide'!A1:AD1"], ["'wide'!A2:AD2"]])
  })
})

describe('nextWithError', () => {
  it('appends the reason textually and keeps the path safe', () => {
    expect(nextWithError('/files/new', 'denied')).toBe('/files/new?google_error=denied')
    expect(nextWithError('/files/new?tab=import#top', 'scope')).toBe('/files/new?tab=import&google_error=scope#top')
    // Not normalised into "//evil" (which a URL parser would make of it).
    expect(nextWithError('/.//evil', 'failed')).toBe('/.//evil?google_error=failed')
  })
})
