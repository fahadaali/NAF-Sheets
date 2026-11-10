import { describe, expect, it } from 'vitest'
import { parseSpreadsheetSource } from '../../src/lib/gsheets-source'
import { t } from '../../src/strings'

const ID = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms'

describe('parseSpreadsheetSource', () => {
  it('takes the id out of the usual Google Sheets addresses', () => {
    const addresses = [
      `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`,
      `https://docs.google.com/spreadsheets/d/${ID}/edit?usp=sharing`,
      `https://docs.google.com/spreadsheets/d/${ID}`,
      `https://docs.google.com/spreadsheets/d/${ID}/`,
      `https://docs.google.com/spreadsheets/u/1/d/${ID}/edit`,
      `docs.google.com/spreadsheets/d/${ID}/edit`,
      `  https://docs.google.com/spreadsheets/d/${ID}/htmlview  `,
    ]
    for (const address of addresses) expect(parseSpreadsheetSource(address), address).toEqual({ ok: true, spreadsheetId: ID })
  })

  it('accepts a bare id, trimmed', () => {
    expect(parseSpreadsheetSource(` ${ID}\n`)).toEqual({ ok: true, spreadsheetId: ID })
  })

  it('says when nothing was pasted', () => {
    expect(parseSpreadsheetSource('   ')).toEqual({ ok: false, problem: 'empty' })
  })

  it('refuses other hosts, other Google products, http and look-alike hosts', () => {
    const others = [
      `http://docs.google.com/spreadsheets/d/${ID}/edit`,
      `https://drive.google.com/file/d/${ID}/view`,
      `https://docs.google.com/document/d/${ID}/edit`,
      `https://docs.google.com.evil.example/spreadsheets/d/${ID}`,
      `https://evil.example/docs.google.com/spreadsheets/d/${ID}`,
      `https://user@docs.google.com/spreadsheets/d/${ID}`,
      `https://docs.google.com:8443/spreadsheets/d/${ID}`,
      `javascript:alert(1)`,
      `https://docs.google.com/spreadsheets/`,
    ]
    for (const address of others) expect(parseSpreadsheetSource(address), address).toEqual({ ok: false, problem: 'not_sheets' })
  })

  it('recognises a "published to the web" address, which has no spreadsheet id', () => {
    expect(parseSpreadsheetSource('https://docs.google.com/spreadsheets/d/e/2PACX-1vSabcdefghijklmnopqrstuvwxyz/pubhtml')).toEqual({
      ok: false,
      problem: 'published',
    })
  })

  it('refuses words and ids that are too short or carry other characters', () => {
    expect(parseSpreadsheetSource('خطة الاتصال')).toEqual({ ok: false, problem: 'invalid_id' })
    expect(parseSpreadsheetSource('abc123')).toEqual({ ok: false, problem: 'invalid_id' })
    expect(parseSpreadsheetSource('https://docs.google.com/spreadsheets/d/short/edit')).toEqual({ ok: false, problem: 'invalid_id' })
    expect(parseSpreadsheetSource(`https://docs.google.com/spreadsheets/d/${ID}%3Cx%3E/edit`)).toEqual({ ok: false, problem: 'invalid_id' })
  })

  it('has an Arabic explanation for every problem', () => {
    for (const problem of ['empty', 'not_sheets', 'published', 'invalid_id'] as const) {
      expect(t.newFile.sourceProblems[problem]).toMatch(/[؀-ۿ]/)
    }
  })
})
