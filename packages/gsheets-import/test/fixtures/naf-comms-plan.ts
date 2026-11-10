// SYNTHETIC FIXTURE — written by hand for the converter tests, NOT exported
// from a real Google Sheets file. It follows the documented response of
// `spreadsheets.get` with includeGridData=true (Sheets API v4 REST reference,
// checked 2026-11-10) and is typed against src/google-types.ts so a wrong
// field name fails the typecheck. Colours are the n/255 fractions the API
// returns; dates are serial numbers (days since 1899-12-30).
//
// Phase 2 acceptance (spec §15) requires a REAL NAF file: a 7-sheet workbook
// with conditional formats, filters and cross-sheet formulas, compared
// visually (≥ 95%). These fixtures do not replace that test; the real file is
// still a carried-forward prerequisite (CLAUDE.md §1).
//
// Workbook: «خطة الاتصال المؤسسي 2026», Arabic, every grid sheet RTL.
//   المهام   (sheetId 0)    tasks: numbering, rich text, links, note, multi-line,
//                           dropdowns (list + range), checkbox, date rule,
//                           conditional formats (text, formula, gradient,
//                           relative date), basic filter, protected range,
//                           filter view, cross-row formulas, hidden column
//   الملخص   (sheetId 1234) merges, cross-sheet formulas, a named range,
//                           IMPORTRANGE / GOOGLEFINANCE / IMAGE / SPARKLINE,
//                           QUERY spilling (unsupported), UNIQUE spilling
//                           (supported), FILTER with two conditions, sheet
//                           link, banded range, chart
//   القوائم  (sheetId 555)  hidden lists for the dropdowns
//   تحليل    (sheetId 777)  pivot table output, slicer, row group, smart chip,
//                           comment anchor
//   مخطط     (sheetId 999)  OBJECT sheet holding a chart

import type { GsCellData, GsColor, GsColorStyle, GsSpreadsheet } from '../../src/google-types'

const rgb = (r: number, g: number, b: number): GsColor => ({ red: r / 255, green: g / 255, blue: b / 255 })
const style = (r: number, g: number, b: number): GsColorStyle => ({ rgbColor: rgb(r, g, b) })

const DATE = { numberFormat: { type: 'DATE' as const, pattern: 'yyyy-mm-dd' } }
const MONEY = { numberFormat: { type: 'NUMBER' as const, pattern: '#,##0.00' } }
const TEXT_FMT = { numberFormat: { type: 'TEXT' as const, pattern: '@' } }

const header = (text: string): GsCellData => ({
  userEnteredValue: { stringValue: text },
  effectiveValue: { stringValue: text },
  formattedValue: text,
  userEnteredFormat: {
    backgroundColorStyle: { themeColor: 'ACCENT1' },
    horizontalAlignment: 'CENTER',
    verticalAlignment: 'MIDDLE',
    textFormat: { bold: true, foregroundColorStyle: { themeColor: 'BACKGROUND' } },
    borders: { bottom: { style: 'SOLID_MEDIUM', colorStyle: style(0, 0, 0) } },
  },
})
const text = (value: string, extra: Partial<GsCellData> = {}): GsCellData => ({
  userEnteredValue: { stringValue: value },
  effectiveValue: { stringValue: value },
  formattedValue: value,
  ...extra,
})
const date = (serial: number, formatted: string): GsCellData => ({
  userEnteredValue: { numberValue: serial },
  effectiveValue: { numberValue: serial },
  formattedValue: formatted,
  userEnteredFormat: DATE,
})
const money = (n: number, formatted: string): GsCellData => ({
  userEnteredValue: { numberValue: n },
  effectiveValue: { numberValue: n },
  formattedValue: formatted,
  userEnteredFormat: MONEY,
})
const bool = (b: boolean): GsCellData => ({
  userEnteredValue: { boolValue: b },
  effectiveValue: { boolValue: b },
  formattedValue: b ? 'TRUE' : 'FALSE',
})
const numbering = (n: string): GsCellData => ({
  userEnteredValue: { stringValue: n },
  effectiveValue: { stringValue: n },
  formattedValue: n,
  userEnteredFormat: TEXT_FMT,
})

const STATUS_RULE = {
  condition: {
    type: 'ONE_OF_LIST' as const,
    values: [{ userEnteredValue: 'منجز' }, { userEnteredValue: 'قيد التنفيذ' }, { userEnteredValue: 'متأخر' }],
  },
  inputMessage: 'اختر حالة المهمة',
  strict: true,
  showCustomUi: true,
}
const OWNER_RULE = {
  condition: { type: 'ONE_OF_RANGE' as const, values: [{ userEnteredValue: "='القوائم'!$A$2:$A$6" }] },
  strict: true,
  showCustomUi: true,
}
const CHECKBOX_RULE = { condition: { type: 'BOOLEAN' as const } }
const DUE_RULE = {
  condition: { type: 'DATE_ON_OR_AFTER' as const, values: [{ userEnteredValue: '2026-01-01' }] },
  strict: false,
}

const status = (value: string): GsCellData => ({ ...text(value), dataValidation: STATUS_RULE })
const owner = (value: string): GsCellData => ({ ...text(value), dataValidation: OWNER_RULE })
const due = (serial: number, formatted: string): GsCellData => ({ ...date(serial, formatted), dataValidation: DUE_RULE })
const review = (b: boolean): GsCellData => ({ ...bool(b), dataValidation: CHECKBOX_RULE })

const RED = style(204, 0, 0)

export const nafCommsPlan: GsSpreadsheet = {
  spreadsheetId: '1SyNtHeTiCfIxTuReNaFcOmMs2026',
  spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/1SyNtHeTiCfIxTuReNaFcOmMs2026/edit',
  properties: {
    title: 'خطة الاتصال المؤسسي 2026',
    locale: 'ar',
    autoRecalc: 'ON_CHANGE',
    timeZone: 'Asia/Riyadh',
    defaultFormat: {
      backgroundColor: rgb(255, 255, 255),
      padding: { top: 2, right: 3, bottom: 2, left: 3 },
      verticalAlignment: 'BOTTOM',
      wrapStrategy: 'OVERFLOW_CELL',
      textFormat: { foregroundColor: {}, fontFamily: 'arial,sans,sans-serif', fontSize: 10, bold: false, italic: false, strikethrough: false, underline: false },
    },
    spreadsheetTheme: {
      primaryFontFamily: 'Arial',
      themeColors: [
        { colorType: 'TEXT', color: { rgbColor: {} } },
        { colorType: 'BACKGROUND', color: style(255, 255, 255) },
        { colorType: 'ACCENT1', color: style(27, 75, 90) },
        { colorType: 'ACCENT2', color: style(234, 67, 53) },
        { colorType: 'ACCENT3', color: style(251, 188, 4) },
        { colorType: 'ACCENT4', color: style(52, 168, 83) },
        { colorType: 'ACCENT5', color: style(255, 109, 1) },
        { colorType: 'ACCENT6', color: style(70, 189, 198) },
        { colorType: 'LINK', color: style(17, 85, 204) },
      ],
    },
  },
  namedRanges: [
    {
      namedRangeId: 'nr-costs',
      name: 'Costs',
      range: { sheetId: 0, startRowIndex: 1, endRowIndex: 6, startColumnIndex: 7, endColumnIndex: 8 },
    },
    {
      namedRangeId: 'nr-team',
      name: 'قائمة_الفريق',
      range: { sheetId: 555, startRowIndex: 1, endRowIndex: 6, startColumnIndex: 0, endColumnIndex: 1 },
    },
  ],
  comments: [
    {
      commentId: 'c1',
      anchorId: 'anchor-1',
      headPost: { content: 'هل نضيف مؤشر الوصول؟' },
      status: 'OPEN',
    },
  ],
  sheets: [
    // -------------------------------------------------------------------------
    // المهام
    // -------------------------------------------------------------------------
    {
      properties: {
        sheetId: 0,
        title: 'المهام',
        index: 0,
        sheetType: 'GRID',
        gridProperties: { rowCount: 100, columnCount: 10, frozenRowCount: 1 },
        tabColor: rgb(27, 75, 90),
        tabColorStyle: style(27, 75, 90),
        rightToLeft: true,
      },
      data: [
        {
          rowData: [
            {
              values: [
                header('#'),
                header('المهمة'),
                header('المسؤول'),
                header('تاريخ البدء'),
                header('تاريخ الاستحقاق'),
                header('الحالة'),
                header('ملاحظات'),
                header('التكلفة'),
                header('مراجعة'),
              ],
            },
            {
              values: [
                numbering('1'),
                text('حملة اليوم الوطني'),
                owner('سارة العتيبي'),
                date(46266, '2026-09-01'),
                due(46288, '2026-09-23'),
                status('منجز'),
                {
                  // "نُشر على X و LinkedIn": X bold, LinkedIn a link.
                  userEnteredValue: { stringValue: 'نُشر على X و LinkedIn' },
                  effectiveValue: { stringValue: 'نُشر على X و LinkedIn' },
                  formattedValue: 'نُشر على X و LinkedIn',
                  textFormatRuns: [
                    { format: {} },
                    { startIndex: 9, format: { bold: true } },
                    { startIndex: 10, format: {} },
                    {
                      startIndex: 13,
                      format: { underline: true, foregroundColorStyle: style(17, 85, 204), link: { uri: 'https://www.linkedin.com/company/naflaw' } },
                    },
                  ],
                },
                money(12500, '12,500.00'),
                review(true),
              ],
            },
            {
              values: [
                numbering('1.1'),
                text('تصميم المنشورات'),
                owner('محمد القحطاني'),
                date(46266, '2026-09-01'),
                due(46275, '2026-09-10'),
                status('منجز'),
                {},
                money(4000, '4,000.00'),
                review(true),
              ],
            },
            {
              values: [
                numbering('1.2'),
                text('جدولة النشر'),
                owner('سارة العتيبي'),
                date(46276, '2026-09-11'),
                due(46285, '2026-09-20'),
                status('قيد التنفيذ'),
                text('المسودة جاهزة\nبانتظار الاعتماد', { userEnteredFormat: { wrapStrategy: 'WRAP' } }),
                money(1500, '1,500.00'),
                review(false),
              ],
            },
            {
              values: [
                numbering('2'),
                text('التقرير السنوي', { note: 'يحتاج موافقة الإدارة قبل النشر' }),
                owner('نورة الشهري'),
                date(46296, '2026-10-01'),
                due(46356, '2026-11-30'),
                status('متأخر'),
                text('انظر الملخص', {
                  hyperlink: '#gid=1234',
                  userEnteredFormat: { textFormat: { underline: true, foregroundColorStyle: { themeColor: 'LINK' }, link: { uri: '#gid=1234' } } },
                }),
                money(30000, '30,000.00'),
                review(false),
              ],
            },
            {
              values: [
                numbering('2.1'),
                text('جمع البيانات'),
                owner('خالد الدوسري'),
                date(46296, '2026-10-01'),
                due(46310, '2026-10-15'),
                status('متأخر'),
                {},
                money(2000, '2,000.00'),
                review(false),
              ],
            },
            {
              values: [
                {},
                text('الإجمالي', { userEnteredFormat: { textFormat: { bold: true } } }),
                {},
                {},
                {},
                {},
                {
                  userEnteredValue: { formulaValue: '=IF(COUNTIF(F2:F6,"متأخر")>0,"يوجد تأخير","")' },
                  effectiveValue: { stringValue: 'يوجد تأخير' },
                  formattedValue: 'يوجد تأخير',
                  userEnteredFormat: { textFormat: { foregroundColorStyle: RED } },
                },
                {
                  userEnteredValue: { formulaValue: '=SUM(H2:H6)' },
                  effectiveValue: { numberValue: 50000 },
                  formattedValue: '50,000.00',
                  userEnteredFormat: { ...MONEY, textFormat: { bold: true } },
                },
              ],
            },
          ],
          rowMetadata: [
            { pixelSize: 32 },
            { pixelSize: 21, hiddenByFilter: true },
            { pixelSize: 21, hiddenByFilter: true },
            { pixelSize: 42 },
            { pixelSize: 21 },
            { pixelSize: 21 },
            { pixelSize: 21 },
            ...Array.from({ length: 93 }, () => ({ pixelSize: 21 })),
          ],
          columnMetadata: [
            { pixelSize: 40 },
            { pixelSize: 220 },
            { pixelSize: 140 },
            { pixelSize: 110 },
            { pixelSize: 110 },
            { pixelSize: 100 },
            { pixelSize: 260 },
            { pixelSize: 100 },
            { pixelSize: 70 },
            { pixelSize: 100, hiddenByUser: true },
          ],
        },
      ],
      conditionalFormats: [
        {
          ranges: [{ sheetId: 0, startRowIndex: 1, endRowIndex: 6, startColumnIndex: 5, endColumnIndex: 6 }],
          booleanRule: {
            condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'متأخر' }] },
            format: { backgroundColorStyle: style(244, 204, 204), textFormat: { bold: true, foregroundColorStyle: RED } },
          },
        },
        {
          ranges: [{ sheetId: 0, startRowIndex: 1, endRowIndex: 6, startColumnIndex: 1, endColumnIndex: 2 }],
          booleanRule: {
            condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=$F2="منجز"' }] },
            format: { textFormat: { strikethrough: true, foregroundColorStyle: style(153, 153, 153) } },
          },
        },
        {
          ranges: [{ sheetId: 0, startRowIndex: 1, endRowIndex: 6, startColumnIndex: 7, endColumnIndex: 8 }],
          gradientRule: {
            minpoint: { colorStyle: style(255, 255, 255), type: 'MIN' },
            midpoint: { colorStyle: style(255, 214, 102), type: 'PERCENTILE', value: '50' },
            maxpoint: { colorStyle: style(87, 187, 138), type: 'MAX' },
          },
        },
        {
          ranges: [{ sheetId: 0, startRowIndex: 1, endRowIndex: 6, startColumnIndex: 4, endColumnIndex: 5 }],
          booleanRule: {
            condition: { type: 'DATE_BEFORE', values: [{ relativeDate: 'TODAY' }] },
            format: { textFormat: { italic: true } },
          },
        },
      ],
      basicFilter: {
        range: { sheetId: 0, startRowIndex: 0, endRowIndex: 6, startColumnIndex: 0, endColumnIndex: 9 },
        sortSpecs: [{ dimensionIndex: 0, sortOrder: 'ASCENDING' }],
        filterSpecs: [
          { columnIndex: 5, filterCriteria: { hiddenValues: ['منجز'] } },
          { columnIndex: 7, filterCriteria: { condition: { type: 'NUMBER_GREATER', values: [{ userEnteredValue: '1000' }] } } },
        ],
        criteria: {
          '5': { hiddenValues: ['منجز'] },
          '7': { condition: { type: 'NUMBER_GREATER', values: [{ userEnteredValue: '1000' }] } },
        },
      },
      filterViews: [
        {
          filterViewId: 1001,
          title: 'متأخرات نورة',
          range: { sheetId: 0, startRowIndex: 0, endRowIndex: 6, startColumnIndex: 0, endColumnIndex: 9 },
          filterSpecs: [{ columnIndex: 2, filterCriteria: { condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'نورة الشهري' }] } } }],
        },
      ],
      protectedRanges: [
        {
          protectedRangeId: 7001,
          range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 9 },
          description: 'صف العناوين',
          warningOnly: false,
          requestingUserCanEdit: true,
          editors: { users: ['admin@naflaw.sa'] },
        },
      ],
    },
    // -------------------------------------------------------------------------
    // الملخص
    // -------------------------------------------------------------------------
    {
      properties: {
        sheetId: 1234,
        title: 'الملخص',
        index: 1,
        sheetType: 'GRID',
        gridProperties: { rowCount: 50, columnCount: 6, frozenRowCount: 2 },
        rightToLeft: true,
      },
      data: [
        {
          rowData: [
            {
              values: [
                text('ملخص خطة الاتصال', {
                  userEnteredFormat: {
                    horizontalAlignment: 'CENTER',
                    textFormat: { bold: true, fontSize: 16, foregroundColorStyle: { themeColor: 'ACCENT1' } },
                  },
                }),
              ],
            },
            { values: [header('البند'), header('القيمة'), header('المصدر'), header('ملاحظات')] },
            {
              values: [
                text('عدد المهام المنجزة'),
                {
                  userEnteredValue: { formulaValue: "=COUNTIF('المهام'!F2:F6,\"منجز\")" },
                  effectiveValue: { numberValue: 2 },
                  formattedValue: '2',
                },
                text('المهام'),
                text('العودة للمهام', {
                  hyperlink: '#gid=0&range=A1',
                  userEnteredFormat: { textFormat: { link: { uri: '#gid=0&range=A1' } } },
                }),
              ],
            },
            {
              values: [
                text('إجمالي التكلفة'),
                {
                  userEnteredValue: { formulaValue: '=SUM(Costs)' },
                  effectiveValue: { numberValue: 50000 },
                  formattedValue: '50,000.00',
                  userEnteredFormat: MONEY,
                },
                text('المهام'),
              ],
            },
            {
              values: [
                text('سعر سهم أرامكو'),
                {
                  userEnteredValue: { formulaValue: '=GOOGLEFINANCE("TADAWUL:2222","price")' },
                  effectiveValue: { numberValue: 27.45 },
                  formattedValue: '27.45',
                  effectiveFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0.00' } },
                },
                text('Google Finance'),
              ],
            },
            {
              values: [
                text('بيانات الفرع'),
                {
                  userEnteredValue: { formulaValue: '=IMPORTRANGE("https://docs.google.com/spreadsheets/d/1BrAnCh/edit","الفرع!B2")' },
                  effectiveValue: { numberValue: 18 },
                  formattedValue: '18',
                  note: 'يُحدَّث أسبوعيًا',
                },
                text('ملف الفرع'),
              ],
            },
            {
              values: [
                text('الشعار'),
                { userEnteredValue: { formulaValue: '=IMAGE("https://naflaw.sa/logo.png")' } },
              ],
            },
            {
              values: [
                text('اتجاه الإنفاق'),
                { userEnteredValue: { formulaValue: "=SPARKLINE('المهام'!H2:H6)" } },
              ],
            },
            { values: [] },
            { values: [header('المهام المتأخرة'), {}, header('الحالات'), {}, header('تأخير مكلف')] },
            {
              values: [
                {
                  userEnteredValue: { formulaValue: "=QUERY('المهام'!B2:F6,\"select B where F = 'متأخر'\",0)" },
                  effectiveValue: { stringValue: 'التقرير السنوي' },
                  formattedValue: 'التقرير السنوي',
                },
                {},
                {
                  userEnteredValue: { formulaValue: "=UNIQUE('المهام'!F2:F6)" },
                  effectiveValue: { stringValue: 'منجز' },
                  formattedValue: 'منجز',
                },
                {},
                {
                  // Google FILTER with two conditions; Univer's third argument is if_empty.
                  userEnteredValue: { formulaValue: "=FILTER('المهام'!B2:B6,'المهام'!F2:F6=\"متأخر\",'المهام'!H2:H6>5000)" },
                  effectiveValue: { stringValue: 'التقرير السنوي' },
                  formattedValue: 'التقرير السنوي',
                },
              ],
            },
            {
              values: [
                { effectiveValue: { stringValue: 'جمع البيانات' }, formattedValue: 'جمع البيانات' },
                {},
                { effectiveValue: { stringValue: 'قيد التنفيذ' }, formattedValue: 'قيد التنفيذ' },
              ],
            },
            {
              values: [{}, {}, { effectiveValue: { stringValue: 'متأخر' }, formattedValue: 'متأخر' }],
            },
          ],
          rowMetadata: Array.from({ length: 50 }, (_, i) => ({ pixelSize: i === 0 ? 36 : 21 })),
          columnMetadata: [{ pixelSize: 180 }, { pixelSize: 120 }, { pixelSize: 120 }, { pixelSize: 160 }, { pixelSize: 100 }, { pixelSize: 100 }],
        },
      ],
      merges: [{ sheetId: 1234, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 4 }],
      bandedRanges: [
        {
          bandedRangeId: 3001,
          range: { sheetId: 1234, startRowIndex: 1, endRowIndex: 8, startColumnIndex: 0, endColumnIndex: 4 },
          rowProperties: {
            headerColorStyle: { themeColor: 'ACCENT1' },
            firstBandColor: rgb(255, 255, 255),
            firstBandColorStyle: style(255, 255, 255),
            secondBandColor: rgb(232, 240, 242),
            secondBandColorStyle: style(232, 240, 242),
          },
        },
      ],
      charts: [
        {
          chartId: 101,
          spec: { title: 'التكلفة حسب المهمة', basicChart: { chartType: 'BAR' } },
          position: { overlayPosition: { anchorCell: { sheetId: 1234, rowIndex: 1, columnIndex: 5 }, widthPixels: 600, heightPixels: 371 } },
        },
      ],
    },
    // -------------------------------------------------------------------------
    // القوائم
    // -------------------------------------------------------------------------
    {
      properties: {
        sheetId: 555,
        title: 'القوائم',
        index: 2,
        sheetType: 'GRID',
        gridProperties: { rowCount: 20, columnCount: 2 },
        hidden: true,
        rightToLeft: true,
      },
      data: [
        {
          rowData: [
            { values: [header('الفريق'), header('الحالات')] },
            { values: [text('سارة العتيبي'), text('منجز')] },
            { values: [text('محمد القحطاني'), text('قيد التنفيذ')] },
            { values: [text('نورة الشهري'), text('متأخر')] },
            { values: [text('خالد الدوسري')] },
            { values: [text('ريم الغامدي')] },
          ],
          rowMetadata: Array.from({ length: 20 }, () => ({ pixelSize: 21 })),
          columnMetadata: [{ pixelSize: 160 }, { pixelSize: 120 }],
        },
      ],
    },
    // -------------------------------------------------------------------------
    // تحليل
    // -------------------------------------------------------------------------
    {
      properties: {
        sheetId: 777,
        title: 'تحليل',
        index: 3,
        sheetType: 'GRID',
        gridProperties: { rowCount: 30, columnCount: 6 },
        rightToLeft: true,
      },
      data: [
        {
          rowData: [
            {
              values: [
                {
                  pivotTable: {
                    source: { sheetId: 0, startRowIndex: 0, endRowIndex: 6, startColumnIndex: 0, endColumnIndex: 9 },
                    rows: [{ sourceColumnOffset: 2, showTotals: true, sortOrder: 'ASCENDING' }],
                    values: [{ summarizeFunction: 'SUM', sourceColumnOffset: 7 }],
                  },
                  effectiveValue: { stringValue: 'المسؤول' },
                  formattedValue: 'المسؤول',
                },
                { effectiveValue: { stringValue: 'SUM of التكلفة' }, formattedValue: 'SUM of التكلفة' },
              ],
            },
            { values: [{ effectiveValue: { stringValue: 'خالد الدوسري' }, formattedValue: 'خالد الدوسري' }, { effectiveValue: { numberValue: 2000 }, formattedValue: '2000' }] },
            { values: [{ effectiveValue: { stringValue: 'سارة العتيبي' }, formattedValue: 'سارة العتيبي' }, { effectiveValue: { numberValue: 14000 }, formattedValue: '14000' }] },
            { values: [{ effectiveValue: { stringValue: 'محمد القحطاني' }, formattedValue: 'محمد القحطاني' }, { effectiveValue: { numberValue: 4000 }, formattedValue: '4000' }] },
            { values: [{ effectiveValue: { stringValue: 'نورة الشهري' }, formattedValue: 'نورة الشهري' }, { effectiveValue: { numberValue: 30000 }, formattedValue: '30000' }] },
            { values: [{ effectiveValue: { stringValue: 'Grand Total' }, formattedValue: 'Grand Total' }, { effectiveValue: { numberValue: 50000 }, formattedValue: '50000' }] },
            { values: [] },
            {
              values: [
                {
                  userEnteredValue: { stringValue: 'المتابعة: @' },
                  effectiveValue: { stringValue: 'المتابعة: @' },
                  formattedValue: 'المتابعة: @',
                  chipRuns: [{ startIndex: 0 }, { startIndex: 10, chip: { personProperties: { email: 'sara@naflaw.sa', displayFormat: 'DEFAULT' } } }],
                },
              ],
            },
          ],
          rowMetadata: Array.from({ length: 30 }, () => ({ pixelSize: 21 })),
          columnMetadata: Array.from({ length: 6 }, () => ({ pixelSize: 120 })),
        },
      ],
      slicers: [
        {
          slicerId: 4001,
          spec: { title: 'تصفية حسب المسؤول', dataRange: { sheetId: 0, startRowIndex: 0, endRowIndex: 6, startColumnIndex: 0, endColumnIndex: 9 }, columnIndex: 2 },
          position: { overlayPosition: { anchorCell: { sheetId: 777, rowIndex: 0, columnIndex: 3 } } },
        },
      ],
      rowGroups: [{ range: { sheetId: 777, dimension: 'ROWS', startIndex: 1, endIndex: 5 }, depth: 1, collapsed: false }],
      commentAnchors: [{ anchorId: 'anchor-1', range: { sheetId: 777, startRowIndex: 5, endRowIndex: 6, startColumnIndex: 1, endColumnIndex: 2 } }],
    },
    // -------------------------------------------------------------------------
    // مخطط (chart sheet)
    // -------------------------------------------------------------------------
    {
      properties: { sheetId: 999, title: 'مخطط', index: 4, sheetType: 'OBJECT' },
      charts: [{ chartId: 202, spec: { title: 'نسبة الإنجاز', pieChart: {} }, position: { sheetId: 999 } }],
    },
  ],
}
