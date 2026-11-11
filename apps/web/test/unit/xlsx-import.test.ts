// «رفع ملف Excel» and «رابط Google Sheets» (owner decision 2026-11-11): the
// browser-side file check, the upload address, the link request, and what the
// report screen states about the file's origin.

import { describe, expect, it } from 'vitest'
import type { ImportReport } from '@naf-sheets/gsheets-import'
import { XLSX_MAX_FILE_BYTES } from '@naf-sheets/shared'
import { createApiClient } from '../../src/lib/api'
import { originFacts, parseImportReport } from '../../src/lib/import-report'
import { xlsxImportPath } from '../../src/lib/upload'
import { checkXlsxFile, formatMegabytes, titleFromFileName } from '../../src/lib/xlsx-file'
import { t } from '../../src/strings'

describe('checkXlsxFile', () => {
  it('accepts an .xlsx up to the limit, whatever the case of its extension', () => {
    expect(checkXlsxFile({ name: 'خطة.xlsx', size: 10 })).toEqual({ ok: true })
    expect(checkXlsxFile({ name: 'PLAN.XLSX', size: XLSX_MAX_FILE_BYTES })).toEqual({ ok: true })
  })

  it('names each problem, and every problem has an Arabic sentence', () => {
    const cases: Array<[Parameters<typeof checkXlsxFile>[0], string]> = [
      [null, 'missing'],
      [{ name: 'a.xlsx', size: 0 }, 'empty'],
      [{ name: 'a.xlsx', size: XLSX_MAX_FILE_BYTES + 1 }, 'too_large'],
      [{ name: 'old.xls', size: 10 }, 'legacy'],
      [{ name: 'bin.xlsb', size: 10 }, 'legacy'],
      [{ name: 'tasks.csv', size: 10 }, 'wrong_type'],
      [{ name: 'sheet.ods', size: 10 }, 'wrong_type'],
      [{ name: 'report.pdf', size: 10 }, 'wrong_type'],
    ]
    for (const [file, problem] of cases) {
      const check = checkXlsxFile(file)
      expect(check).toEqual({ ok: false, problem })
      expect(t.newFile.fileProblems[problem as keyof typeof t.newFile.fileProblems]).toMatch(/[؀-ۿ]/)
    }
  })

  it('suggests the file name as the title and formats sizes with Latin digits', () => {
    expect(titleFromFileName('خطة الربع.xlsx')).toBe('خطة الربع')
    expect(formatMegabytes(1.5 * 1024 * 1024)).toBe('1.5')
    expect(t.newFile.fileHint(15)).toContain('15')
  })
})

describe('upload and link requests', () => {
  it('sends the file name and the optional title in the query', () => {
    expect(xlsxImportPath('خطة الحملة.xlsx')).toBe(`/api/import/xlsx?name=${encodeURIComponent('خطة الحملة.xlsx').replace(/%20/g, '+')}`)
    expect(xlsxImportPath('a.xlsx', 'عنوان')).toBe(`/api/import/xlsx?name=a.xlsx&title=${encodeURIComponent('عنوان')}`)
  })

  it('posts a link import without touching the Google OAuth endpoints', async () => {
    const calls: Array<[string, string, unknown]> = []
    const client = createApiClient({
      fetch: async (path, init) => {
        calls.push([init.method ?? 'GET', path, init.body ? JSON.parse(String(init.body)) : undefined])
        return new Response(JSON.stringify({ workbookId: 'w', reportId: 'r' }), { status: 201 })
      },
    })
    expect(await client.importGsheetsLink({ source: 'abc', title: 'خطة' })).toEqual({ workbookId: 'w', reportId: 'r' })
    expect(calls).toEqual([['POST', '/api/import/gsheets-link', { source: 'abc', title: 'خطة' }]])
  })

  it('surfaces the API’s Arabic message for a private file', async () => {
    const message = 'تعذّر تنزيل الملف لأنه غير مشارك بالرابط.'
    const client = createApiClient({ fetch: async () => new Response(JSON.stringify({ ok: false, error: 'gsheets_link_private', message }), { status: 403 }) })
    await expect(client.importGsheetsLink({ source: 'abc' })).rejects.toMatchObject({ status: 403, code: 'gsheets_link_private', message })
  })
})

const base: ImportReport = {
  source: { spreadsheetId: null, title: 'خطة', locale: null },
  counts: { sheets: 1, cells: 1, formulas: 0, valueOnlyFormulas: 0, styles: 0, merges: 0, conditionalFormatRules: 0, dataValidationRules: 0, filters: 0, notes: 0, hyperlinks: 0, richTextCells: 0, definedNames: 0 },
  sheets: [{ googleSheetId: 1, sheetId: 'sheet-1', name: 'المهام', hidden: false, rightToLeft: true }],
  items: [],
}

describe('origin on the report screen', () => {
  it('reads the origin of an .xlsx import', () => {
    const report = parseImportReport({
      ...base,
      source: { ...base.source, origin: { kind: 'excel', via: 'upload', application: 'Microsoft Excel', fileName: 'خطة.xlsx', defaultFont: { family: 'Calibri', size: 11 }, dateSystem: 'date1904', alignment: 'as_given' } },
    })
    expect(report).not.toBeNull()
    expect(originFacts(report as ImportReport)).toEqual({ kind: 'excel', via: 'upload', application: 'Microsoft Excel', fileName: 'خطة.xlsx', defaultFont: 'Calibri 11', dateSystem: 'date1904' })
  })

  it('treats a report without origin (stored before 2026-11-11) as a Sheets API import', () => {
    expect(originFacts(parseImportReport(base) as ImportReport)).toMatchObject({ kind: 'google_api', via: 'google_api', defaultFont: null })
  })

  it('drops an unreadable origin instead of refusing the whole report', () => {
    const report = parseImportReport({ ...base, source: { ...base.source, origin: { kind: 'zip', via: 'mail' } } })
    expect(report).not.toBeNull()
    expect(report?.source.origin).toBeUndefined()
  })

  it('has an Arabic label for every origin and way in', () => {
    for (const kind of ['google_api', 'google_export', 'excel', 'other']) expect(t.report.originKinds[kind]).toMatch(/[؀-ۿ]/)
    for (const via of ['google_api', 'upload', 'google_link']) expect(t.report.via[via]).toMatch(/[؀-ۿ]/)
    expect(t.report.alignmentValue).toContain('بداية السطر')
  })
})
