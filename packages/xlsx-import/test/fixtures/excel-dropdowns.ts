// SYNTHESISED fixture: every Excel list and validation feature the import
// handles (apps/api OPEN_QUESTIONS.md "Google import" G32), written part by
// part as ECMA-376 Part 1 §18.3.1.32–33 and MS-XLSX (x14:dataValidation)
// describe them. No Excel was available; the structures are the ones the
// real-file-checked reader already reads, plus the attributes Excel writes
// for each option of its Data Validation dialog:
//
//   Main!A2:A4  category names (Fruits / Vegetables), the parent of B
//   Main!B2:B4  dependent list INDIRECT($A2) (relative: moves per row in Excel)
//   Main!C2:C4  named range =Statuses, input title + message, error style
//               "warning" with title + message
//   Main!D2:D4  inline list "أ,ب ""ج"",د" (quotes doubled), showDropDown="1"
//               (the arrow HIDDEN), error style "information"
//   Main!E2:E4  OFFSET dynamic list on another sheet, in <extLst> (x14),
//               no error alert at all (showErrorMessage absent);
//               E4 holds "Apple, Pear": not a multiple selection in Excel
//   Main!F2:F4  whole number between 1 and 10, "Ignore blank" off, stop + message
//   Main!G2:G4  text length ≤ 5
//   Main!H2:H4  time (no Univer validator)
//   Main!I2:I4  absolute same-sheet range $K$2:$K$4
//   Main!J2:J3  relative same-sheet range K2:K4 (moves per row)
//   Lists!A1:C3 Fruits, Vegetables, Statuses (defined names)

import { buildZip, type ZipInput } from '../helpers/zip-writer'

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const str = (ref: string, text: string) => `<c r="${ref}" t="inlineStr"><is><t>${esc(text)}</t></is></c>`
const num = (ref: string, n: number) => `<c r="${ref}"><v>${n}</v></c>`
const row = (r: number, cells: string[]) => `<row r="${r}">${cells.join('')}</row>`

function rels(list: Array<[string, string, string]>): string {
  return `${DECL}<Relationships xmlns="${NS_PKG_REL}">${list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`).join('')}</Relationships>`
}

function mainSheet(dependentRows: number): string {
  const rows = [
    row(1, ['الفئة', 'الصنف', 'الحالة', 'الأولوية', 'المصدر', 'العدد', 'الرمز', 'الوقت', 'ثابت', 'نسبي', 'قيم'].map((h, i) => str(`${'ABCDEFGHIJK'[i]}1`, h))),
    row(2, [str('A2', 'Fruits'), str('B2', 'Pear'), str('C2', 'منجز'), str('D2', 'أ'), str('E2', 'Apple'), num('F2', 3), str('G2', 'abc'), str('I2', 'س'), str('J2', 'س'), str('K2', 'س')]),
    row(3, [str('A3', 'Vegetables'), str('B3', 'Leek'), str('C3', 'متأخر'), str('D3', 'ب "ج"'), str('E3', 'Plum'), num('F3', 7), str('G3', 'abcdef'), str('I3', 'ص'), str('J3', 'ع'), str('K3', 'ص')]),
    row(4, [str('A4', 'Fruits'), str('B4', 'Plum'), str('E4', 'Apple, Pear'), str('K4', 'ع')]),
  ]
  // A cell in the last row of a stretched column B, so the grid reaches it.
  if (dependentRows > 3) rows.push(row(dependentRows + 1, [str(`A${dependentRows + 1}`, 'Fruits')]))
  const dv = [
    `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="B2:B${dependentRows + 1}"><formula1>INDIRECT($A2)</formula1></dataValidation>`,
    `<dataValidation type="list" errorStyle="warning" allowBlank="1" showInputMessage="1" showErrorMessage="1" errorTitle="قيمة غير معروفة" error="اختر حالة من القائمة" promptTitle="الحالة" prompt="اختر حالة المهمة" sqref="C2:C4"><formula1>Statuses</formula1></dataValidation>`,
    `<dataValidation type="list" errorStyle="information" allowBlank="1" showDropDown="1" showErrorMessage="1" sqref="D2:D4"><formula1>"أ,ب ""ج"",د"</formula1></dataValidation>`,
    `<dataValidation type="whole" operator="between" showErrorMessage="1" error="العدد بين 1 و10" sqref="F2:F4"><formula1>1</formula1><formula2>10</formula2></dataValidation>`,
    `<dataValidation type="textLength" operator="lessThanOrEqual" allowBlank="1" showErrorMessage="1" sqref="G2:G4"><formula1>5</formula1></dataValidation>`,
    `<dataValidation type="time" operator="greaterThan" allowBlank="1" showErrorMessage="1" sqref="H2:H4"><formula1>0.375</formula1></dataValidation>`,
    `<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="I2:I4"><formula1>$K$2:$K$4</formula1></dataValidation>`,
    `<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="J2:J3"><formula1>K2:K4</formula1></dataValidation>`,
  ]
  const x14 = `<extLst><ext uri="{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:dataValidations count="1" xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main"><x14:dataValidation type="list" allowBlank="1"><x14:formula1><xm:f>OFFSET(Lists!$A$1,0,0,COUNTA(Lists!$A:$A),1)</xm:f></x14:formula1><xm:sqref>E2:E4</xm:sqref></x14:dataValidation></x14:dataValidations></ext></extLst>`
  return `${DECL}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_R}"><sheetViews><sheetView rightToLeft="1" tabSelected="1" workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData>${rows.join('')}</sheetData><dataValidations count="${dv.length}">${dv.join('')}</dataValidations>${x14}</worksheet>`
}

function listsSheet(): string {
  const cols = [
    ['Apple', 'Pear', 'Plum'],
    ['Carrot', 'Leek', 'Onion'],
    ['قيد التنفيذ', 'منجز', 'متأخر'],
  ]
  const rows = [0, 1, 2].map((r) => row(r + 1, cols.map((c, k) => str(`${'ABC'[k]}${r + 1}`, c[r] as string))))
  return `${DECL}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_R}"><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetData>${rows.join('')}</sheetData></worksheet>`
}

const STYLES = `${DECL}<styleSheet xmlns="${NS_MAIN}"><fonts count="1"><font><sz val="11"/><name val="Aptos Narrow"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`

/** `dependentRows`: rows the INDIRECT list of column B covers (default 3: B2:B4). */
export async function buildExcelDropdownFixture(dependentRows = 3): Promise<Uint8Array> {
  const workbook = `${DECL}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_R}"><sheets><sheet name="Main" sheetId="1" r:id="rId1"/><sheet name="Lists" sheetId="2" r:id="rId2"/></sheets><definedNames><definedName name="Fruits">Lists!$A$1:$A$3</definedName><definedName name="Statuses">Lists!$C$1:$C$3</definedName><definedName name="Vegetables">Lists!$B$1:$B$3</definedName></definedNames><calcPr calcId="191029"/></workbook>`
  const files: ZipInput[] = [
    {
      name: '[Content_Types].xml',
      data: `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
    },
    {
      name: '_rels/.rels',
      data: rels([
        ['rId1', `${REL}/officeDocument`, 'xl/workbook.xml'],
        ['rId2', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties', 'docProps/app.xml'],
      ]),
    },
    {
      name: 'docProps/app.xml',
      data: `${DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Excel</Application><AppVersion>16.0300</AppVersion></Properties>`,
    },
    { name: 'xl/workbook.xml', data: workbook },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: rels([
        ['rId1', `${REL}/worksheet`, 'worksheets/sheet1.xml'],
        ['rId2', `${REL}/worksheet`, 'worksheets/sheet2.xml'],
        ['rId3', `${REL}/styles`, 'styles.xml'],
      ]),
    },
    { name: 'xl/worksheets/sheet1.xml', data: mainSheet(dependentRows) },
    { name: 'xl/worksheets/sheet2.xml', data: listsSheet() },
    { name: 'xl/styles.xml', data: STYLES },
  ]
  return buildZip(files)
}
