// SYNTHESISED fixture: an .xlsx built part by part the way Microsoft Excel
// (Microsoft 365, 2023+ defaults) writes one. No Excel was available, so this
// generator reproduces Excel's documented structures (ECMA-376 Part 1 and the
// MS-XLSX extensions) rather than a file Excel saved:
//   docProps/app.xml <Application>Microsoft Excel</Application>, the 2023
//   "Office Theme" (Aptos Narrow 11, dk1/lt1 as sysClr), theme colours with
//   tint, indexed colours, built-in number formats without a <numFmt> entry
//   (14, 10, 22, 7), a custom one (164), shared formulas, a legacy array
//   formula, a dynamic array (_xlfn._xlws.SORT with cm="1"), _xlfn./_xludf.
//   prefixes, a structured table reference, a link to another workbook, the
//   1904 date system (option), x14 data validation in <extLst>, sparklines,
//   a threaded comment with its legacy copy, a table with a built-in style,
//   a pivot table, a chart sheet, pictures/charts/shapes in a drawing,
//   outline levels, sheet protection, a filter with criteria.
// apps/api/OPEN_QUESTIONS.md "Google import" G20 says which fixtures are real.
//
// `buildGoogleStyleFixture` builds a small file the way Google's export
// writes one (structure copied from the real exports in this folder), for
// the apps/api tests, which run in workerd and cannot read files from disk.

import { buildZip, type ZipInput } from '../helpers/zip-writer'

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'

/** Days since 1899-12-30 (1900 system) or since 1904-01-01 (1904 system). */
export function serial(iso: string, date1904 = false): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  const days = (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000
  return date1904 ? days - 1462 : days
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const EXCEL_STRINGS = [
  'المهمة', // 0
  'المسؤول', // 1
  'تاريخ الاستحقاق', // 2
  'المبلغ', // 3
  'الحالة', // 4
  'منجزة', // 5
  'إعداد الخطة', // 6
  'أحمد', // 7
  'قيد التنفيذ', // 8
  null, // 9: rich text
  'منجز', // 10
  'الموقع', // 11
  '00123', // 12
  'سارة', // 13
  'تصميم الهوية', // 14
  'كتابة المحتوى', // 15
  'النشر', // 16
  'المتابعة', // 17
  'خالد', // 18
  'البند', // 19
  'متأخر', // 20
] as const

const TASKS: Array<[number, number, string, number, number, boolean]> = [
  // [task string, owner string, due, amount, status string, done]
  [6, 7, '2026-01-15', 1200, 10, true],
  [14, 13, '2026-02-01', 800, 8, false],
  [15, 7, '2026-02-20', 450.5, 8, false],
  [16, 18, '2026-03-01', 2000, 20, false],
  [17, 13, '2026-03-15', 300, 8, false],
]

function sheet1(date1904: boolean): string {
  const rows: string[] = []
  rows.push(
    `<row r="1" spans="1:8" ht="30" customHeight="1" x14ac:dyDescent="0.25">${[0, 1, 2, 3, 4, 5].map((s, i) => `<c r="${'ABCDEF'[i]}1" s="1" t="s"><v>${s}</v></c>`).join('')}<c r="H1" s="1" t="s"><v>3</v></c></row>`,
  )
  TASKS.forEach(([task, owner, due, amount, status, done], i) => {
    const r = i + 2
    const hidden = r === 5 ? ' hidden="1"' : ''
    const h = (amount * 1.15).toString()
    const hf = r === 2 ? `<f t="shared" ref="H2:H6" si="0">D2*1.15</f>` : '<f t="shared" si="0"/>'
    rows.push(
      `<row r="${r}" spans="1:8"${hidden} x14ac:dyDescent="0.25"><c r="A${r}" t="s"><v>${task}</v></c><c r="B${r}" t="s"><v>${owner}</v></c><c r="C${r}" s="2"><v>${serial(due, date1904)}</v></c><c r="D${r}" s="3"><v>${amount}</v></c><c r="E${r}" t="s"><v>${status}</v></c><c r="F${r}" t="b"><v>${done ? 1 : 0}</v></c><c r="G${r}"><v>${r}</v></c><c r="H${r}">${hf}<v>${h}</v></c></row>`,
    )
  })
  rows.push(`<row r="7" spans="1:8" x14ac:dyDescent="0.25"><c r="A7" s="4" t="s"><v>3</v></c><c r="B7" s="4"/><c r="C7" s="4"/><c r="D7" s="3"><f>SUM(D2:D6)</f><v>4750.5</v></c></row>`)
  rows.push(
    `<row r="8" spans="1:8" x14ac:dyDescent="0.25"><c r="A8" t="str"><f>_xlfn.XLOOKUP("أحمد",B2:B6,A2:A6)</f><v>إعداد الخطة</v></c><c r="B8" s="8"><v>${serial('2026-01-15', date1904) + 0.5}</v></c><c r="C8" s="10"><v>99</v></c><c r="E8" s="7"><v>0.25</v></c></row>`,
  )
  rows.push(
    `<row r="9" spans="1:8" x14ac:dyDescent="0.25"><c r="A9" cm="1"><f t="array" ref="A9:A11">_xlfn._xlws.SORT(D2:D4)</f><v>450.5</v></c><c r="B9"><f t="array" ref="B9">SUM(D2:D6*1)</f><v>4750.5</v></c><c r="C9"><f>_xludf.MYFUNC(D2)</f><v>5</v></c><c r="D9"><f>SUM(Table1[المبلغ])</f><v>1500</v></c><c r="E9"><f>[1]Sheet1!$A$1</f><v>7</v></c><c r="F9" t="e"><v>#N/A</v></c><c r="G9" t="e"><f>1/0</f><v>#DIV/0!</v></c></row>`,
  )
  rows.push(`<row r="10" spans="1:8" x14ac:dyDescent="0.25"><c r="A10"><v>800</v></c></row>`)
  rows.push(`<row r="11" spans="1:8" x14ac:dyDescent="0.25"><c r="A11"><v>1200</v></c></row>`)
  rows.push(
    `<row r="12" spans="1:8" x14ac:dyDescent="0.25"><c r="A12" s="5" t="s"><v>9</v></c><c r="B12" s="11" t="s"><v>12</v></c><c r="C12" t="inlineStr"><is><t>نص مضمّن</t></is></c><c r="D12" s="12" t="s"><v>11</v></c><c r="E12" s="6"><v>1</v></c><c r="F12" s="9"/></row>`,
  )
  return `${DECL}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_R}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac xr xr2 xr3" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision" xmlns:xr2="http://schemas.microsoft.com/office/spreadsheetml/2015/revision2" xmlns:xr3="http://schemas.microsoft.com/office/spreadsheetml/2016/revision3" xr:uid="{6F1C2B44-3D2A-4B8E-9C55-1A2B3C4D5E6F}"><sheetPr><tabColor theme="5" tint="-0.249977111117893"/></sheetPr><dimension ref="A1:H12"/><sheetViews><sheetView rightToLeft="1" tabSelected="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15" x14ac:dyDescent="0.25"/><cols><col min="1" max="1" width="30.7109375" customWidth="1"/><col min="2" max="3" width="15.7109375" customWidth="1"/><col min="7" max="7" width="9.140625" hidden="1" customWidth="1"/></cols><sheetData>${rows.join('')}</sheetData><autoFilter ref="A1:F6" xr:uid="{00000000-0009-0000-0000-000000000000}"><filterColumn colId="4"><filters><filter val="قيد التنفيذ"/><filter val="منجز"/></filters></filterColumn></autoFilter><mergeCells count="1"><mergeCell ref="A7:C7"/></mergeCells><conditionalFormatting sqref="D2:D6"><cfRule type="cellIs" dxfId="0" priority="2" operator="greaterThan"><formula>1000</formula></cfRule><cfRule type="cellIs" dxfId="1" priority="3" operator="lessThan"><formula>$D$7/10</formula></cfRule></conditionalFormatting><conditionalFormatting sqref="A2:F6"><cfRule type="expression" dxfId="1" priority="1"><formula>$F2=TRUE</formula></cfRule></conditionalFormatting><conditionalFormatting sqref="H2:H6"><cfRule type="colorScale" priority="4"><colorScale><cfvo type="min"/><cfvo type="percentile" val="50"/><cfvo type="max"/><color rgb="FFF8696B"/><color rgb="FFFFEB84"/><color rgb="FF63BE7B"/></colorScale></cfRule></conditionalFormatting><conditionalFormatting sqref="D2:D6"><cfRule type="dataBar" priority="5"><dataBar><cfvo type="min"/><cfvo type="max"/><color rgb="FF638EC6"/></dataBar></cfRule></conditionalFormatting><conditionalFormatting sqref="E2:E6"><cfRule type="containsText" dxfId="0" priority="6" operator="containsText" text="قيد"><formula>NOT(ISERROR(SEARCH("قيد",E2)))</formula></cfRule></conditionalFormatting><dataValidations count="4"><dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" prompt="اختر الحالة" sqref="E2:E6"><formula1>"قيد التنفيذ,منجز,متأخر"</formula1></dataValidation><dataValidation type="whole" operator="greaterThanOrEqual" allowBlank="1" showErrorMessage="1" sqref="D2:D6"><formula1>0</formula1></dataValidation><dataValidation type="date" errorStyle="warning" allowBlank="1" showErrorMessage="1" sqref="C2:C6"><formula1>${serial('2026-01-01', date1904)}</formula1><formula2>${serial('2026-12-31', date1904)}</formula2></dataValidation><dataValidation type="textLength" operator="lessThan" allowBlank="1" showErrorMessage="1" sqref="A2:A6"><formula1>100</formula1></dataValidation></dataValidations><hyperlinks><hyperlink ref="D12" r:id="rId1" display="https://naflaw.sa" xr:uid="{11111111-2222-3333-4444-555555555555}"/><hyperlink ref="B6" location="'القوائم'!A1" display="القوائم" xr:uid="{11111111-2222-3333-4444-666666666666}"/></hyperlinks><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/><drawing r:id="rId2"/><legacyDrawing r:id="rId3"/><extLst><ext uri="{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:dataValidations count="1" xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main"><x14:dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1"><x14:formula1><xm:f>'القوائم'!$A$1:$A$3</xm:f></x14:formula1><xm:sqref>B2:B6</xm:sqref></x14:dataValidation></x14:dataValidations></ext><ext uri="{05C60535-1F16-4fd2-B633-F4F36F0B64E0}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:sparklineGroups xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main"><x14:sparklineGroup displayEmptyCellsAs="gap"><x14:colorSeries theme="4"/><x14:sparklines><x14:sparkline><xm:f>'المهام'!D2:D6</xm:f><xm:sqref>D8</xm:sqref></x14:sparkline></x14:sparklines></x14:sparklineGroup></x14:sparklineGroups></ext></extLst></worksheet>`
}

function sheet2(): string {
  return `${DECL}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_R}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac"><dimension ref="A1:G7"/><sheetViews><sheetView rightToLeft="1" workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15" outlineLevelRow="1" x14ac:dyDescent="0.25"/><sheetData><row r="1"><c r="A1" t="s"><v>7</v></c><c r="C1" t="s"><v>19</v></c><c r="D1" t="s"><v>3</v></c></row><row r="2"><c r="A2" t="s"><v>13</v></c><c r="C2" t="s"><v>6</v></c><c r="D2"><v>1000</v></c></row><row r="3"><c r="A3" t="s"><v>18</v></c><c r="C3" t="s"><v>14</v></c><c r="D3"><v>500</v></c></row><row r="4"><c r="C4" t="s"><v>16</v></c><c r="D4"><v>0</v></c></row><row r="6" outlineLevel="1"><c r="A6"><v>1</v></c></row><row r="7" outlineLevel="1"><c r="A7"><v>2</v></c></row></sheetData><sheetProtection algorithmName="SHA-512" hashValue="bXsYvZx0Wq8AlP3Kc9U2dQ==" saltValue="c2FsdHNhbHRzYWx0c2FsdA==" spinCount="100000" sheet="1" objects="1" scenarios="1"/><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/><legacyDrawing r:id="rId2"/><tableParts count="1"><tablePart r:id="rId1"/></tableParts></worksheet>`
}

function sheet3(): string {
  return `${DECL}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_R}"><dimension ref="A1"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData><row r="1"><c r="A1"><v>42</v></c></row></sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`
}

const THEME = `${DECL}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="0E2841"/></a:dk2><a:lt2><a:srgbClr val="E8E8E8"/></a:lt2><a:accent1><a:srgbClr val="156082"/></a:accent1><a:accent2><a:srgbClr val="E97132"/></a:accent2><a:accent3><a:srgbClr val="196B24"/></a:accent3><a:accent4><a:srgbClr val="0F9ED5"/></a:accent4><a:accent5><a:srgbClr val="A02B93"/></a:accent5><a:accent6><a:srgbClr val="4EA72E"/></a:accent6><a:hlink><a:srgbClr val="467886"/></a:hlink><a:folHlink><a:srgbClr val="96607D"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Aptos Display" panose="02110004020202020204"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Aptos Narrow" panose="02110004020202020204"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`

const STYLES = `${DECL}<styleSheet xmlns="${NS_MAIN}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac x16r2 xr" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" xmlns:x16r2="http://schemas.microsoft.com/office/spreadsheetml/2015/02/main" xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00\\ &quot;ر.س&quot;"/></numFmts><fonts count="5" x14ac:knownFonts="1"><font><sz val="11"/><color theme="1"/><name val="Aptos Narrow"/><family val="2"/><scheme val="minor"/></font><font><b/><sz val="11"/><color theme="0"/><name val="Aptos Narrow"/><family val="2"/><scheme val="minor"/></font><font><sz val="11"/><color theme="4" tint="-0.249977111117893"/><name val="Aptos Narrow"/><family val="2"/><scheme val="minor"/></font><font><u/><sz val="11"/><color theme="10"/><name val="Aptos Narrow"/><family val="2"/><scheme val="minor"/></font><font><i/><sz val="14"/><color indexed="10"/><name val="Arial"/><family val="2"/></font></fonts><fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor theme="4"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor theme="5" tint="0.79998168889431442"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor indexed="13"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="lightGray"><fgColor rgb="FF00B0F0"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color indexed="64"/></left><right style="medium"><color theme="4"/></right><top style="dashed"><color auto="1"/></top><bottom style="double"><color rgb="FFFF0000"/></bottom><diagonal/></border></borders><cellStyleXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="3" fillId="0" borderId="0" applyNumberFormat="0" applyFill="0" applyBorder="0" applyAlignment="0" applyProtection="0"/></cellStyleXfs><cellXfs count="13"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" readingOrder="2" textRotation="45"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1"/></xf><xf numFmtId="0" fontId="4" fillId="4" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment textRotation="135"/></xf><xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="22" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="5" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="7" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" quotePrefix="1" applyNumberFormat="1"/><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="1" applyAlignment="1"><alignment textRotation="255"/></xf></cellXfs><cellStyles count="2"><cellStyle name="Hyperlink" xfId="1" builtinId="8"/><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="2"><dxf><font><b/><color rgb="FF9C0006"/></font><fill><patternFill><bgColor rgb="FFFFC7CE"/></patternFill></fill></dxf><dxf><font><color rgb="FF006100"/></font><fill><patternFill><bgColor rgb="FFC6EFCE"/></patternFill></fill></dxf></dxfs><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>`

function sharedStrings(): string {
  const items = EXCEL_STRINGS.map((s, i) => {
    if (i === 9) {
      return '<si><r><rPr><b/><sz val="11"/><color theme="1"/><rFont val="Aptos Narrow"/><family val="2"/><scheme val="minor"/></rPr><t xml:space="preserve">مهم: </t></r><r><rPr><sz val="11"/><color rgb="FFFF0000"/><rFont val="Aptos Narrow"/><family val="2"/><scheme val="minor"/></rPr><t>مراجعة العقد</t></r></si>'
    }
    return `<si><t>${esc(s as string)}</t></si>`
  })
  return `${DECL}<sst xmlns="${NS_MAIN}" count="${items.length}" uniqueCount="${items.length}">${items.join('')}</sst>`
}

function rels(list: Array<[string, string, string, boolean?]>): string {
  return `${DECL}<Relationships xmlns="${NS_PKG_REL}">${list
    .map(([id, type, target, external]) => `<Relationship Id="${id}" Type="${type}" Target="${esc(target)}"${external ? ' TargetMode="External"' : ''}/>`)
    .join('')}</Relationships>`
}

const DRAWING = `${DECL}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>9</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>11</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>5</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="Picture 1" descr="شعار"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip xmlns:r="${NS_R}" r:embed="rId1"/></xdr:blipFill><xdr:spPr/></xdr:pic><xdr:clientData/></xdr:twoCellAnchor><xdr:twoCellAnchor><xdr:from><xdr:col>9</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>7</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>15</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>20</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="3" name="Chart 2"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${NS_R}" r:id="rId2"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor><xdr:oneCellAnchor><xdr:from><xdr:col>9</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>22</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="914400" cy="457200"/><xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="4" name="TextBox 3"/><xdr:cNvSpPr txBox="1"/></xdr:nvSpPr><xdr:spPr/><xdr:txBody><a:bodyPr/><a:p><a:r><a:t>ملاحظة</a:t></a:r></a:p></xdr:txBody></xdr:sp><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>`

const CHART = `${DECL}<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/><c:ser><c:idx val="0"/><c:order val="0"/><c:val><c:numRef><c:f>'المهام'!$D$2:$D$6</c:f></c:numRef></c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart><c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:crossAx val="1"/></c:valAx></c:plotArea><c:plotVisOnly val="1"/></c:chart></c:chartSpace>`

const TABLE = `${DECL}<table xmlns="${NS_MAIN}" id="1" name="Table1" displayName="Table1" ref="C1:D4" totalsRowShown="0"><autoFilter ref="C1:D4"/><tableColumns count="2"><tableColumn id="1" name="البند"/><tableColumn id="2" name="المبلغ"/></tableColumns><tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>`

const PIVOT = `${DECL}<pivotTableDefinition xmlns="${NS_MAIN}" name="PivotTable1" cacheId="1" dataCaption="Values"><location ref="F1:G4" firstHeaderRow="1" firstDataRow="1" firstDataCol="1"/><pivotFields count="2"><pivotField showAll="0"/><pivotField dataField="1" showAll="0"/></pivotFields></pivotTableDefinition>`

const COMMENTS = `${DECL}<comments xmlns="${NS_MAIN}"><authors><author>tc={AAA}</author><author>سارة</author></authors><commentList><comment ref="A1" authorId="0" shapeId="0"><text><t>[Threaded comment]

Your version of Excel allows you to read this threaded comment; however, any edits to it will get removed if the file is opened in a newer version of Excel. Learn more: https://go.microsoft.com/fwlink/?linkid=870924

Comment:
    راجع الأسماء</t></text></comment><comment ref="A2" authorId="1" shapeId="0"><text><r><rPr><b/><sz val="9"/><color indexed="81"/><rFont val="Tahoma"/></rPr><t>سارة:</t></r><r><rPr><sz val="9"/><color indexed="81"/><rFont val="Tahoma"/></rPr><t xml:space="preserve">
ملاحظة على البند</t></r></text></comment></commentList></comments>`

const THREADED = `${DECL}<ThreadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"><threadedComment ref="A1" dT="2026-11-01T09:00:00.00" personId="{11111111-0000-0000-0000-000000000001}" id="{AAA}"><text>راجع الأسماء</text></threadedComment></ThreadedComments>`

const VML = `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><v:shape id="_x0000_s1025" type="#_x0000_t202"><x:ClientData ObjectType="Note"><x:Row>0</x:Row><x:Column>0</x:Column></x:ClientData></v:shape></xml>`

const CHARTSHEET = `${DECL}<chartsheet xmlns="${NS_MAIN}" xmlns:r="${NS_R}"><sheetViews><sheetView workbookViewId="0"/></sheetViews><drawing r:id="rId1"/></chartsheet>`

export interface ExcelFixtureOptions {
  date1904?: boolean
}

export async function buildExcelFixture(options: ExcelFixtureOptions = {}): Promise<Uint8Array> {
  const date1904 = options.date1904 ?? false
  const workbook = `${DECL}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_R}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x15 xr xr6 xr10 xr2" xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main" xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision" xmlns:xr6="http://schemas.microsoft.com/office/spreadsheetml/2016/revision6" xmlns:xr10="http://schemas.microsoft.com/office/spreadsheetml/2016/revision10" xmlns:xr2="http://schemas.microsoft.com/office/spreadsheetml/2015/revision2"><fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="28526"/><workbookPr${date1904 ? ' date1904="1"' : ''} defaultThemeVersion="202300"/><bookViews><workbookView xWindow="-110" yWindow="-110" windowWidth="25820" windowHeight="15500"/></bookViews><sheets><sheet name="المهام" sheetId="1" r:id="rId1"/><sheet name="القوائم" sheetId="2" r:id="rId2"/><sheet name="مخفية" sheetId="3" state="hidden" r:id="rId3"/><sheet name="مخطط" sheetId="4" r:id="rId4"/></sheets><externalReferences><externalReference r:id="rId9"/></externalReferences><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'المهام'!$A$1:$F$6</definedName><definedName name="_xlnm.Print_Area" localSheetId="0">'المهام'!$A$1:$H$12</definedName><definedName name="Rate">0.15</definedName><definedName name="المبالغ">'المهام'!$D$2:$D$6</definedName></definedNames><calcPr calcId="191029"/><pivotCaches><pivotCache cacheId="1" r:id="rId8"/></pivotCaches></workbook>`
  const files: ZipInput[] = [
    {
      name: '[Content_Types].xml',
      data: `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/chartsheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml"/><Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/><Override PartName="/xl/tables/table1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/><Override PartName="/xl/pivotTables/pivotTable1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml"/><Override PartName="/xl/pivotCache/pivotCacheDefinition1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml"/><Override PartName="/xl/comments1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/><Override PartName="/xl/threadedComments/threadedComment1.xml" ContentType="application/vnd.ms-excel.threadedcomments+xml"/><Override PartName="/xl/externalLinks/externalLink1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
    },
    {
      name: '_rels/.rels',
      data: rels([
        ['rId3', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties', 'docProps/app.xml'],
        ['rId2', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml'],
        ['rId1', `${REL}/officeDocument`, 'xl/workbook.xml'],
      ]),
    },
    {
      name: 'docProps/app.xml',
      data: `${DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Microsoft Excel</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop><Company></Company><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0300</AppVersion></Properties>`,
    },
    {
      name: 'docProps/core.xml',
      data: `${DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>خطة الحملة</dc:title><dc:creator>ناف</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">2026-11-01T08:00:00Z</dcterms:created></cp:coreProperties>`,
    },
    { name: 'xl/workbook.xml', data: workbook },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: rels([
        ['rId1', `${REL}/worksheet`, 'worksheets/sheet1.xml'],
        ['rId2', `${REL}/worksheet`, 'worksheets/sheet2.xml'],
        ['rId3', `${REL}/worksheet`, 'worksheets/sheet3.xml'],
        ['rId4', `${REL}/chartsheet`, 'chartsheets/sheet1.xml'],
        ['rId5', `${REL}/theme`, 'theme/theme1.xml'],
        ['rId6', `${REL}/styles`, 'styles.xml'],
        ['rId7', `${REL}/sharedStrings`, 'sharedStrings.xml'],
        ['rId8', `${REL}/pivotCacheDefinition`, 'pivotCache/pivotCacheDefinition1.xml'],
        ['rId9', `${REL}/externalLink`, 'externalLinks/externalLink1.xml'],
      ]),
    },
    { name: 'xl/worksheets/sheet1.xml', data: sheet1(date1904) },
    {
      name: 'xl/worksheets/_rels/sheet1.xml.rels',
      data: rels([
        ['rId1', `${REL}/hyperlink`, 'https://naflaw.sa', true],
        ['rId2', `${REL}/drawing`, '../drawings/drawing1.xml'],
        ['rId3', `${REL}/vmlDrawing`, '../drawings/vmlDrawing1.vml'],
      ]),
    },
    { name: 'xl/worksheets/sheet2.xml', data: sheet2() },
    {
      name: 'xl/worksheets/_rels/sheet2.xml.rels',
      data: rels([
        ['rId1', `${REL}/table`, '../tables/table1.xml'],
        ['rId2', `${REL}/vmlDrawing`, '../drawings/vmlDrawing2.vml'],
        ['rId3', `${REL}/comments`, '../comments1.xml'],
        ['rId4', 'http://schemas.microsoft.com/office/2017/10/relationships/threadedComment', '../threadedComments/threadedComment1.xml'],
        ['rId5', `${REL}/pivotTable`, '../pivotTables/pivotTable1.xml'],
      ]),
    },
    { name: 'xl/worksheets/sheet3.xml', data: sheet3() },
    { name: 'xl/chartsheets/sheet1.xml', data: CHARTSHEET },
    { name: 'xl/chartsheets/_rels/sheet1.xml.rels', data: rels([['rId1', `${REL}/drawing`, '../drawings/drawing2.xml']]) },
    { name: 'xl/drawings/drawing1.xml', data: DRAWING },
    {
      name: 'xl/drawings/_rels/drawing1.xml.rels',
      data: rels([
        ['rId1', `${REL}/image`, '../media/image1.png'],
        ['rId2', `${REL}/chart`, '../charts/chart1.xml'],
      ]),
    },
    { name: 'xl/drawings/drawing2.xml', data: `${DECL}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"/>` },
    { name: 'xl/drawings/vmlDrawing1.vml', data: VML },
    { name: 'xl/drawings/vmlDrawing2.vml', data: VML },
    { name: 'xl/media/image1.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), deflate: false },
    { name: 'xl/charts/chart1.xml', data: CHART },
    { name: 'xl/tables/table1.xml', data: TABLE },
    { name: 'xl/pivotTables/pivotTable1.xml', data: PIVOT },
    { name: 'xl/pivotTables/_rels/pivotTable1.xml.rels', data: rels([['rId1', `${REL}/pivotCacheDefinition`, '../pivotCache/pivotCacheDefinition1.xml']]) },
    {
      name: 'xl/pivotCache/pivotCacheDefinition1.xml',
      data: `${DECL}<pivotCacheDefinition xmlns="${NS_MAIN}" xmlns:r="${NS_R}" refreshOnLoad="1" recordCount="0"><cacheSource type="worksheet"><worksheetSource ref="C1:D4" sheet="القوائم"/></cacheSource><cacheFields count="2"><cacheField name="البند" numFmtId="0"><sharedItems/></cacheField><cacheField name="المبلغ" numFmtId="0"><sharedItems containsNumber="1" minValue="0" maxValue="1000"/></cacheField></cacheFields></pivotCacheDefinition>`,
    },
    { name: 'xl/comments1.xml', data: COMMENTS },
    { name: 'xl/threadedComments/threadedComment1.xml', data: THREADED },
    { name: 'xl/externalLinks/_rels/externalLink1.xml.rels', data: rels([['rId1', `${REL}/externalLinkPath`, 'budget.xlsx', true]]) },
    { name: 'xl/externalLinks/externalLink1.xml', data: `${DECL}<externalLink xmlns="${NS_MAIN}"><externalBook xmlns:r="${NS_R}" r:id="rId1"/></externalLink>` },
    { name: 'xl/theme/theme1.xml', data: THEME },
    { name: 'xl/styles.xml', data: STYLES },
    { name: 'xl/sharedStrings.xml', data: sharedStrings() },
  ]
  return buildZip(files)
}

/**
 * A small Google-export-shaped file (structure as in the real exports here):
 * no docProps, the Mac namespaces on <workbook>, an empty persons part, the
 * "Sheets" theme, Arial 10, a checkbox column written as booleans, a
 * DUMMYFUNCTION formula with its COMPUTED_VALUE spill, a dropdown.
 */
export async function buildGoogleStyleFixture(sheetName = 'المهام'): Promise<Uint8Array> {
  const ns =
    'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mx="http://schemas.microsoft.com/office/mac/excel/2008/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:mv="urn:schemas-microsoft-com:mac:vml" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main"'
  const files: ZipInput[] = [
    {
      name: 'xl/worksheets/sheet1.xml',
      data: `${DECL.trim()}<worksheet ${ns}><sheetPr><outlinePr summaryBelow="0" summaryRight="0"/></sheetPr><sheetViews><sheetView rightToLeft="1" workbookViewId="0"><pane ySplit="1.0" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr customHeight="1" defaultColWidth="12.63" defaultRowHeight="15.75"/><cols><col customWidth="1" min="1" max="1" width="24.63"/></cols><sheetData><row r="1"><c r="A1" s="1" t="s"><v>0</v></c><c r="B1" s="1" t="s"><v>1</v></c><c r="C1" s="1" t="s"><v>2</v></c><c r="D1" s="1" t="str"><f>IFERROR(__xludf.DUMMYFUNCTION("QUERY(A1:C3,""select A"",1)"),"المهمة")</f><v>المهمة</v></c></row><row r="2"><c r="A2" s="2" t="s"><v>3</v></c><c r="B2" s="2" t="b"><v>1</v></c><c r="C2" s="2" t="s"><v>4</v></c><c r="D2" t="str"><f>IFERROR(__xludf.DUMMYFUNCTION("""COMPUTED_VALUE"""),"إعداد الخطة")</f><v>إعداد الخطة</v></c></row><row r="3"><c r="A3" s="2" t="s"><v>5</v></c><c r="B3" s="2" t="b"><v>0</v></c><c r="C3" s="2" t="s"><v>6</v></c><c r="D3" t="str"><f>IFERROR(__xludf.DUMMYFUNCTION("""COMPUTED_VALUE"""),"تصميم الهوية")</f><v>تصميم الهوية</v></c></row></sheetData><dataValidations><dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="C2:C3"><formula1>"قيد التنفيذ,منجز"</formula1></dataValidation><dataValidation type="custom" allowBlank="1" showDropDown="1" sqref="E2:E3"><formula1>OR(NOT(ISERROR(DATEVALUE(E2))), AND(ISNUMBER(E2), LEFT(CELL(&quot;format&quot;, E2))=&quot;D&quot;))</formula1></dataValidation></dataValidations><drawing r:id="rId1"/></worksheet>`,
    },
    {
      name: 'xl/worksheets/_rels/sheet1.xml.rels',
      data: `${DECL.trim()}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${REL}/drawing" Target="../drawings/drawing1.xml"/></Relationships>`,
    },
    {
      name: 'xl/drawings/drawing1.xml',
      data: `${DECL.trim()}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/>`,
    },
    {
      name: 'xl/sharedStrings.xml',
      data: `${DECL.trim()}<sst xmlns="${NS_MAIN}" count="7" uniqueCount="7">${['المهمة', 'منجزة', 'الحالة', 'إعداد الخطة', 'منجز', 'تصميم الهوية', 'قيد التنفيذ'].map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`,
    },
    {
      name: 'xl/styles.xml',
      data: `${DECL.trim()}<styleSheet xmlns="${NS_MAIN}" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><fonts count="3"><font><sz val="10.0"/><color rgb="FF000000"/><name val="Arial"/><scheme val="minor"/></font><font><b/><color theme="1"/><name val="Arial"/><scheme val="minor"/></font><font><color theme="1"/><name val="Arial"/><scheme val="minor"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="lightGray"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9EAD3"/><bgColor rgb="FFD9EAD3"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf borderId="0" fillId="0" fontId="0" numFmtId="0" applyAlignment="1" applyFont="1"/></cellStyleXfs><cellXfs count="3"><xf borderId="0" fillId="0" fontId="0" numFmtId="0" xfId="0" applyAlignment="1" applyFont="1"><alignment readingOrder="0" shrinkToFit="0" vertical="bottom" wrapText="0"/></xf><xf borderId="0" fillId="2" fontId="1" numFmtId="0" xfId="0" applyAlignment="1" applyFill="1" applyFont="1"><alignment readingOrder="0"/></xf><xf borderId="0" fillId="0" fontId="2" numFmtId="0" xfId="0" applyAlignment="1" applyFont="1"><alignment readingOrder="0"/></xf></cellXfs><cellStyles count="1"><cellStyle xfId="0" name="Normal" builtinId="0"/></cellStyles><dxfs count="0"/></styleSheet>`,
    },
    {
      name: 'xl/theme/theme1.xml',
      data: `${DECL.trim()}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" name="Sheets"><a:themeElements><a:clrScheme name="Sheets"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="000000"/></a:dk2><a:lt2><a:srgbClr val="FFFFFF"/></a:lt2><a:accent1><a:srgbClr val="4285F4"/></a:accent1><a:accent2><a:srgbClr val="EA4335"/></a:accent2><a:accent3><a:srgbClr val="FBBC04"/></a:accent3><a:accent4><a:srgbClr val="34A853"/></a:accent4><a:accent5><a:srgbClr val="FF6D01"/></a:accent5><a:accent6><a:srgbClr val="46BDC6"/></a:accent6><a:hlink><a:srgbClr val="1155CC"/></a:hlink><a:folHlink><a:srgbClr val="1155CC"/></a:folHlink></a:clrScheme><a:fontScheme name="Sheets"><a:majorFont><a:latin typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`,
    },
    { name: 'xl/persons/person.xml', data: `${DECL.trim()}<x18tc:personList xmlns:x18tc="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"/>` },
    {
      name: 'xl/workbook.xml',
      data: `${DECL.trim()}<workbook ${ns.replace(/ xmlns:x14ac[^ ]*/, '')}><workbookPr/><sheets><sheet state="visible" name="${esc(sheetName)}" sheetId="1" r:id="rId4"/></sheets><definedNames/><calcPr/></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `${DECL.trim()}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${REL}/theme" Target="theme/theme1.xml"/><Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rId3" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId5" Type="http://schemas.microsoft.com/office/2017/10/relationships/person" Target="persons/person.xml"/><Relationship Id="rId4" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    },
    { name: '_rels/.rels', data: `${DECL.trim()}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    {
      name: '[Content_Types].xml',
      data: `${DECL.trim()}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default ContentType="application/xml" Extension="xml"/><Default ContentType="application/vnd.openxmlformats-package.relationships+xml" Extension="rels"/><Override ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml" PartName="/xl/worksheets/sheet1.xml"/><Override ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml" PartName="/xl/workbook.xml"/></Types>`,
    },
  ]
  return buildZip(files)
}
