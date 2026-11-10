// Loads the converted synthetic workbook into a headless Univer 1.4.0 and
// checks that the engine accepts and uses what the converter wrote: formulas
// (cross-sheet, Arabic sheet names, named range, spilling), every resource,
// conditional formats, data validation, the filter, notes and links.
//
// The web app loads the same snapshot through @univerjs/presets; this test
// registers the underlying plugins directly (test/helpers/headless-univer.ts).

import { DataValidationStatus, type ICellData } from '@univerjs/core'
import { IDefinedNamesService } from '@univerjs/engine-formula'
import { ConditionalFormattingService } from '@univerjs/sheets-conditional-formatting'
import { SheetsDataValidationValidatorService } from '@univerjs/sheets-data-validation'
import { SheetsFilterService } from '@univerjs/sheets-filter'
import { SheetsNoteModel } from '@univerjs/sheets-note'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { convertSpreadsheet } from '../src'
import { nafCommsPlan } from './fixtures/naf-comms-plan'
import { loadHeadless, waitFor, type HeadlessUniver } from './helpers/headless-univer'

const { workbook: data } = convertSpreadsheet(nafCommsPlan)
const TASKS = 'sheet-0'
const SUMMARY = 'sheet-1234'

describe('converted workbook in headless Univer 1.4.0', () => {
  let u: HeadlessUniver
  beforeAll(() => {
    // Overwrite every cached formula value so the checks below can only pass
    // if Univer computed the formulas itself.
    const poisoned = structuredClone(data)
    for (const sheet of Object.values(poisoned.sheets)) {
      for (const row of Object.values(sheet.cellData ?? {})) {
        for (const cell of Object.values(row ?? {}) as Array<ICellData | undefined>) if (cell?.f) cell.v = -1
      }
    }
    u = loadHeadless(poisoned, 'forced')
  })
  afterAll(() => u.dispose())

  it('loads every sheet in order with its properties', () => {
    const sheets = u.workbook.getSheets()
    expect(sheets.map((s) => s.getName())).toEqual(['المهام', 'الملخص', 'القوائم', 'تحليل'])
    const tasks = u.workbook.getSheetBySheetId(TASKS)
    expect(tasks?.isRightToLeft()).toBe(1)
    expect(tasks?.getFreeze()).toMatchObject({ ySplit: 1, startRow: 1, xSplit: 0 })
    expect(u.workbook.getSheetBySheetId('sheet-555')?.isSheetHidden()).toBe(1)
    expect(tasks?.getColumnWidth(1)).toBe(220)
    expect(tasks?.getRowHeight(0)).toBe(32)
  })

  it('computes cross-sheet formulas, the named range and the supported spill', async () => {
    const summary = u.workbook.getSheetBySheetId(SUMMARY)
    const tasks = u.workbook.getSheetBySheetId(TASKS)
    // Forced calculation: these values come from Univer, not from the (poisoned) cached v.
    await waitFor(() => summary?.getCell(12, 2)?.v && summary?.getCellRaw(3, 1)?.v !== -1)
    expect(summary?.getCellRaw(2, 1)?.v).toBe(2) // =COUNTIF('المهام'!F2:F6,"منجز")
    expect(summary?.getCellRaw(3, 1)?.v).toBe(50000) // =SUM(Costs)
    expect(tasks?.getCellRaw(6, 7)?.v).toBe(50000) // =SUM(H2:H6)
    expect(tasks?.getCellRaw(6, 6)?.v).toBe('يوجد تأخير')
    // =UNIQUE('المهام'!F2:F6) spills into the cells the converter left empty.
    const spilled = [0, 1, 2].map((i) => u.workbook.getSheetBySheetId(SUMMARY)?.getCell(10 + i, 2)?.v)
    expect(spilled).toEqual(['منجز', 'قيد التنفيذ', 'متأخر'])
  })

  it('accepts every resource as written', () => {
    const loaded = u.resources()
    const written = Object.fromEntries((data.resources ?? []).map((r) => [r.name, JSON.parse(r.data)]))
    expect(loaded.SHEET_CONDITIONAL_FORMATTING_PLUGIN).toEqual(written.SHEET_CONDITIONAL_FORMATTING_PLUGIN)
    expect(loaded.SHEET_DATA_VALIDATION_PLUGIN).toEqual(written.SHEET_DATA_VALIDATION_PLUGIN)
    expect(loaded.SHEET_NOTE_PLUGIN).toEqual(written.SHEET_NOTE_PLUGIN)
    expect(loaded.SHEET_DEFINED_NAME_PLUGIN).toEqual(written.SHEET_DEFINED_NAME_PLUGIN)
    // The filter model adds its computed cache; the definition is unchanged.
    const filter = loaded.SHEET_FILTER_PLUGIN as Record<string, { ref: unknown; filterColumns: unknown }>
    const writtenFilter = written.SHEET_FILTER_PLUGIN as Record<string, { ref: unknown; filterColumns: unknown }>
    expect(filter[TASKS]?.ref).toEqual(writtenFilter[TASKS]?.ref)
    expect(filter[TASKS]?.filterColumns).toEqual(writtenFilter[TASKS]?.filterColumns)
  })

  it('registers the named ranges, including an Arabic name', () => {
    const names = u.get<IDefinedNamesService>(IDefinedNamesService)
    expect(names.getValueByName(data.id, 'Costs')?.formulaOrRefString).toBe("'المهام'!$H$2:$H$6")
    expect(names.getValueByName(data.id, 'قائمة_الفريق')?.formulaOrRefString).toBe("'القوائم'!$A$2:$A$6")
  })

  it('hides the same rows with the filter as Google did (rows 2 and 3: "منجز")', async () => {
    const model = u.get<SheetsFilterService>(SheetsFilterService).getFilterModel(data.id, TASKS)
    expect(model).toBeTruthy()
    const hidden = await waitFor(() => {
      const rows = [1, 2, 3, 4, 5].filter((r) => model?.isRowFiltered(r))
      return rows.length > 0 ? rows : null
    })
    expect(hidden).toEqual([1, 2])
  })

  it('validates the dropdowns (list and range on an Arabic sheet), checkbox and date rule', async () => {
    const validator = u.get<SheetsDataValidationValidatorService>(SheetsDataValidationValidatorService)
    expect(await validator.validatorCell(data.id, TASKS, 1, 5)).toBe(DataValidationStatus.VALID) // الحالة: منجز
    expect(await validator.validatorCell(data.id, TASKS, 1, 2)).toBe(DataValidationStatus.VALID) // المسؤول from 'القوائم'
    expect(await validator.validatorCell(data.id, TASKS, 1, 8)).toBe(DataValidationStatus.VALID) // checkbox TRUE
    expect(await validator.validatorCell(data.id, TASKS, 1, 4)).toBe(DataValidationStatus.VALID) // due ≥ 2026-01-01
  })

  it('applies the conditional formats', async () => {
    const cf = u.get<ConditionalFormattingService>(ConditionalFormattingService)
    // F5 = "متأخر" → red fill; B2 (F2 = "منجز") → strikethrough.
    const late = await waitFor(() => cf.composeStyle(data.id, TASKS, 4, 5)?.style)
    expect(late).toMatchObject({ bg: { rgb: '#f4cccc' }, bl: 1 })
    const done = await waitFor(() => cf.composeStyle(data.id, TASKS, 1, 1)?.style)
    expect(done).toMatchObject({ st: { s: 1 } })
  })

  it('keeps notes and hyperlinks', () => {
    const notes = u.get<SheetsNoteModel>(SheetsNoteModel)
    expect(notes.getNote(data.id, TASKS, { row: 4, col: 1 })?.note).toBe('يحتاج موافقة الإدارة قبل النشر')
    const link = u.workbook.getSheetBySheetId(TASKS)?.getCellRaw(1, 6)?.p?.body?.customRanges?.[0]
    expect(link?.properties?.url).toBe('https://www.linkedin.com/company/naflaw')
  })
})

describe('cached values without forced calculation', () => {
  it('shows Google\'s last values until something recalculates (WHEN_EMPTY)', async () => {
    const u = loadHeadless(data, 'when_empty')
    try {
      const summary = u.workbook.getSheetBySheetId(SUMMARY)
      // Value-only cells keep Google's value; kept formulas show the cached v.
      expect(summary?.getCellRaw(4, 1)?.v).toBe(27.45)
      expect(summary?.getCellRaw(2, 1)?.v).toBe(2)
      // The spilling formula was written without v, so WHEN_EMPTY computes it.
      await waitFor(() => summary?.getCell(12, 2)?.v)
      expect(summary?.getCell(12, 2)?.v).toBe('متأخر')
    } finally {
      u.dispose()
    }
  })
})
