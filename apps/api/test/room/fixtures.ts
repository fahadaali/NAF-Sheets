// A realistic workbook for room tests and the feasibility spike: several task
// sheets of a few hundred rows (text, dates, numbers, a per-row formula), a
// summary sheet with cross-sheet formulas, styles, notes and data validation.
// Values a theme would supply are test data, not interface code.

export const SET_RANGE_VALUES = 'sheet.mutation.set-range-values'

export interface FixtureOptions {
  workbookId: string
  taskSheets?: number
  rows?: number
}

type Cell = { v?: string | number; f?: string; s?: string; t?: number }

export function sheetId(index: number): string {
  return `sheet-${index + 1}`
}

export const SUMMARY_SHEET = 'sheet-summary'

/** `IWorkbookData` (Univer 1.4.0) with `taskSheets` × `rows` task rows and a summary sheet. */
export function realisticWorkbook(options: FixtureOptions): Record<string, unknown> {
  const taskSheets = options.taskSheets ?? 3
  const rows = options.rows ?? 300
  const sheets: Record<string, unknown> = {}
  const order: string[] = []
  const names: string[] = []

  for (let s = 0; s < taskSheets; s++) {
    const id = sheetId(s)
    const name = `المهام ${s + 1}`
    order.push(id)
    names.push(name)
    const cellData: Record<number, Record<number, Cell>> = {
      0: Object.fromEntries(
        ['المهمة', 'المسؤول', 'تاريخ البدء', 'تاريخ الاستحقاق', 'منجزة', 'الأولوية', 'القناة', 'الميزانية', 'المتبقي', 'ملاحظات', 'الحالة', 'المرجع'].map((v, c) => [c, { v, s: 'h' }]),
      ),
    }
    for (let r = 1; r <= rows; r++) {
      cellData[r] = {
        0: { v: `مهمة رقم ${r} في الورقة ${s + 1}` },
        1: { v: ['سارة', 'خالد', 'نورة', 'فهد'][r % 4]! },
        2: { v: 46300 + (r % 40), t: 2, s: 'd' },
        3: { v: 46320 + (r % 60), t: 2, s: 'd' },
        4: { v: r % 3 === 0 ? 1 : 0, t: 3 },
        5: { v: ['عالية', 'متوسطة', 'منخفضة'][r % 3]! },
        6: { v: ['X', 'LinkedIn', 'البريد', 'الموقع'][r % 4]! },
        7: { v: 1000 + ((r * 37) % 9000), t: 2 },
        8: { f: `=D${r + 1}-46336` },
        9: { v: r % 5 === 0 ? 'يحتاج مراجعة قانونية قبل النشر' : '' },
        10: { f: `=IF(E${r + 1}=1,"منجزة","قيد العمل")` },
        11: { v: `REF-${s + 1}-${String(r).padStart(4, '0')}` },
      }
    }
    sheets[id] = {
      id,
      name,
      rowCount: Math.max(1000, rows + 50),
      columnCount: 26,
      rightToLeft: 1,
      cellData,
      columnData: { 0: { w: 260 }, 9: { w: 220 } },
      rowData: { 0: { h: 30 } },
    }
  }

  const summary: Record<number, Record<number, Cell>> = { 0: { 0: { v: 'الورقة', s: 'h' }, 1: { v: 'عدد المهام', s: 'h' }, 2: { v: 'الميزانية', s: 'h' }, 3: { v: 'آخر استحقاق', s: 'h' }, 4: { v: 'المنجز', s: 'h' } } }
  names.forEach((name, i) => {
    const last = rows + 1
    summary[i + 1] = {
      0: { v: name },
      1: { f: `=COUNTA('${name}'!A2:A${last})` },
      2: { f: `=SUM('${name}'!H2:H${last})` },
      3: { f: `=MAX('${name}'!D2:D${last})` },
      4: { f: `=SUMIF('${name}'!E2:E${last},1,'${name}'!H2:H${last})` },
    }
  })
  sheets[SUMMARY_SHEET] = { id: SUMMARY_SHEET, name: 'الملخص', rowCount: 100, columnCount: 10, rightToLeft: 1, cellData: summary }
  order.push(SUMMARY_SHEET)

  const notes: Record<string, unknown> = {}
  const validation: Record<string, unknown> = {}
  for (let s = 0; s < taskSheets; s++) {
    const id = sheetId(s)
    notes[id] = { 3: { 1: { id: `n-${s}`, row: 3, col: 1, width: 160, height: 72, note: 'تأكد من الهوية' } } }
    validation[id] = [{ uid: `dv-${s}`, type: 'checkbox', ranges: [{ startRow: 1, endRow: rows, startColumn: 4, endColumn: 4 }] }]
  }

  return {
    id: options.workbookId,
    name: 'خطة الاتصال المؤسسي',
    appVersion: '1.4.0',
    locale: 'arSA',
    styles: { h: { bl: 1 }, d: { n: { pattern: 'yyyy-mm-dd' } } },
    sheetOrder: order,
    sheets,
    resources: [
      { name: 'SHEET_NOTE_PLUGIN', data: JSON.stringify(notes) },
      { name: 'SHEET_DATA_VALIDATION_PLUGIN', data: JSON.stringify(validation) },
    ],
  }
}

/** One cell edit, as the editor's SetRangeValuesMutation carries it. */
export function setCell(unitId: string, subUnitId: string, row: number, col: number, cell: Cell | null): { id: string; params: Record<string, unknown> } {
  return { id: SET_RANGE_VALUES, params: { unitId, subUnitId, cellValue: { [row]: { [col]: cell } } } }
}
