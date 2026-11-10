// Output properties that the API and the workbook room rely on: the converter
// is deterministic, does not mutate its input, and produces plain JSON (the
// snapshot is stored in R2 and the report sent to the browser as JSON).
// (File name kept from an exploratory probe; the project rule is never to delete files.)

import { describe, expect, it } from 'vitest'
import { convertSpreadsheet } from '../src'
import { englishLtr } from './fixtures/english-ltr'
import { nafCommsPlan } from './fixtures/naf-comms-plan'

describe('converter output', () => {
  for (const [name, fixture] of [['naf-comms-plan', nafCommsPlan], ['english-ltr', englishLtr]] as const) {
    it(`${name}: is identical across runs`, () => {
      expect(JSON.stringify(convertSpreadsheet(fixture))).toBe(JSON.stringify(convertSpreadsheet(fixture)))
    })

    it(`${name}: survives a JSON round trip unchanged`, () => {
      const result = convertSpreadsheet(fixture)
      expect(JSON.parse(JSON.stringify(result))).toEqual(result)
    })

    it(`${name}: does not modify the response`, () => {
      const before = JSON.stringify(fixture)
      convertSpreadsheet(fixture)
      expect(JSON.stringify(fixture)).toBe(before)
    })
  }

  it('the fixtures themselves are plain JSON, as an API response would be', () => {
    expect(JSON.parse(JSON.stringify(nafCommsPlan))).toEqual(nafCommsPlan)
  })

  it('handles an empty response', () => {
    const { workbook, report } = convertSpreadsheet({})
    expect(workbook).toMatchObject({ id: 'gsheets-import', name: '', sheetOrder: [], sheets: {}, styles: {}, resources: [] })
    expect(report.counts.sheets).toBe(0)
    expect(report.items).toEqual([])
  })
})
