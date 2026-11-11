// SYNTHESISED fixture: an .xlsx shaped like Excel 365's, with every picture
// anchor kind (twoCellAnchor default and editAs="oneCell", oneCellAnchor,
// absoluteAnchor), a refused type (EMF), a linked picture, and "Place in cell"
// pictures (xl/metadata.xml + xl/richData/*: a local image with alt text, a
// web image, an EMF). No Excel was available: the parts follow ECMA-376 and
// [MS-XLSX] as Excel writes them. Used by test/images.test.ts and apps/api.

import { buildZip } from '../helpers/zip-writer'

export const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
export const EMF = new Uint8Array([0x01, 0x00, 0x00, 0x00, 0x6c, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0])

// ---------------------------------------------------------------------------
// Synthesised Excel file: every anchor kind and Excel 365's in-cell pictures
// ---------------------------------------------------------------------------

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS_PKG = 'http://schemas.openxmlformats.org/package/2006/relationships'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
const rels = (list: Array<[string, string, string, string?]>) =>
  `${DECL}<Relationships xmlns="${NS_PKG}">${list.map(([id, type, target, mode]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"${mode ? ` TargetMode="${mode}"` : ''}/>`).join('')}</Relationships>`
const EMU = 9525
const pic = (id: number, rid: string, name: string, descr = '', attr = 'r:embed') =>
  `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${id}" name="${name}"${descr ? ` descr="${descr}"` : ''}/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip xmlns:r="${NS_R}" ${attr}="${rid}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>`
const from = (col: number, colOff: number, row: number, rowOff: number, tag = 'from') =>
  `<xdr:${tag}><xdr:col>${col}</xdr:col><xdr:colOff>${colOff * EMU}</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>${rowOff * EMU}</xdr:rowOff></xdr:${tag}>`

export async function excelPicturesFixture(): Promise<Uint8Array> {
  const drawing = `${DECL}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    // 1. Excel's default: move and size with cells.
    `<xdr:twoCellAnchor>${from(3, 10, 1, 4)}${from(5, 20, 4, 8, 'to')}${pic(2, 'rId1', 'Picture 1', 'شعار ناف')}<xdr:clientData/></xdr:twoCellAnchor>` +
    // 2. "Move but don't size with cells".
    `<xdr:twoCellAnchor editAs="oneCell">${from(0, 0, 6, 0)}${from(1, 0, 8, 0, 'to')}${pic(3, 'rId1', 'Picture 2')}<xdr:clientData/></xdr:twoCellAnchor>` +
    // 3. One-cell anchor with its extent.
    `<xdr:oneCellAnchor>${from(2, 5, 10, 3)}<xdr:ext cx="${100 * EMU}" cy="${50 * EMU}"/>${pic(4, 'rId1', 'Picture 3')}<xdr:clientData/></xdr:oneCellAnchor>` +
    // 4. "Don't move or size with cells" in absolute position.
    `<xdr:absoluteAnchor><xdr:pos x="${300 * EMU}" y="${200 * EMU}"/><xdr:ext cx="${40 * EMU}" cy="${30 * EMU}"/>${pic(5, 'rId1', 'Picture 4')}<xdr:clientData/></xdr:absoluteAnchor>` +
    // 5. An EMF (not a type the platform accepts).
    `<xdr:oneCellAnchor>${from(7, 0, 1, 0)}<xdr:ext cx="${20 * EMU}" cy="${20 * EMU}"/>${pic(6, 'rId2', 'Picture 5')}<xdr:clientData/></xdr:oneCellAnchor>` +
    // 6. A picture linked to an address (no bytes in the file).
    `<xdr:oneCellAnchor>${from(8, 0, 1, 0)}<xdr:ext cx="${20 * EMU}" cy="${20 * EMU}"/>${pic(7, 'rId3', 'Picture 6', '', 'r:link')}<xdr:clientData/></xdr:oneCellAnchor>` +
    `</xdr:wsDr>`
  const sheet = `${DECL}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_R}"><sheetViews><sheetView rightToLeft="1" workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="1" width="20.7109375" customWidth="1"/></cols><sheetData>` +
    `<row r="1"><c r="A1" t="inlineStr"><is><t>المهمة</t></is></c><c r="B1" t="inlineStr"><is><t>الصورة</t></is></c></row>` +
    `<row r="3"><c r="A3" t="inlineStr"><is><t>إعداد الخطة</t></is></c><c r="B3" t="e" vm="1"><v>#VALUE!</v></c><c r="C3" t="e" vm="2"><v>#VALUE!</v></c><c r="D3" t="e" vm="3"><v>#VALUE!</v></c></row>` +
    `</sheetData><drawing r:id="rId1"/></worksheet>`
  const metadata = `${DECL}<metadata xmlns="${NS_MAIN}" xmlns:xlrd="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata"><metadataTypes count="1"><metadataType name="XLRICHVALUE" minSupportedVersion="120000" copy="1" pasteAll="1" pasteValues="1" merge="1" splitFirst="1" rowColShift="1" clearFormats="1" clearComments="1" assign="1" coerce="1"/></metadataTypes>` +
    `<futureMetadata name="XLRICHVALUE" count="3"><bk><extLst><ext uri="{3e2802c4-a4d2-4d8b-9148-e3be6c30e623}"><xlrd:rvb i="0"/></ext></extLst></bk><bk><extLst><ext uri="{3e2802c4-a4d2-4d8b-9148-e3be6c30e623}"><xlrd:rvb i="1"/></ext></extLst></bk><bk><extLst><ext uri="{3e2802c4-a4d2-4d8b-9148-e3be6c30e623}"><xlrd:rvb i="2"/></ext></extLst></bk></futureMetadata>` +
    `<valueMetadata count="3"><bk><rc t="1" v="0"/></bk><bk><rc t="1" v="1"/></bk><bk><rc t="1" v="2"/></bk></valueMetadata></metadata>`
  const RD = 'http://schemas.microsoft.com/office/spreadsheetml/2017/richdata'
  const richValues = `${DECL}<rvData xmlns="${RD}" count="3"><rv s="0"><v>0</v><v>5</v><v>صورة المنتج</v></rv><rv s="1"><v>0</v><v>1</v></rv><rv s="2"><v>1</v><v>5</v></rv></rvData>`
  const structures = `${DECL}<rvStructures xmlns="${RD}" count="3"><s t="_localImage"><k n="_rvRel:LocalImageIdentifier" t="i"/><k n="CalcOrigin" t="i"/><k n="Text" t="s"/></s><s t="_webimage"><k n="WebImageIdentifier" t="i"/><k n="CalcOrigin" t="i"/></s><s t="_localImage"><k n="_rvRel:LocalImageIdentifier" t="i"/><k n="CalcOrigin" t="i"/></s></rvStructures>`
  const richRels = `${DECL}<richValueRels xmlns="http://schemas.microsoft.com/office/spreadsheetml/2022/richvaluerel" xmlns:r="${NS_R}"><rel r:id="rId1"/><rel r:id="rId2"/></richValueRels>`
  const web = `${DECL}<webImagesSrd xmlns="http://schemas.microsoft.com/office/spreadsheetml/2020/richdatawebimage" xmlns:r="${NS_R}"><webImageSrd><address r:id="rId1"/></webImageSrd></webImagesSrd>`
  return buildZip([
    { name: '[Content_Types].xml', data: `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/><Default Extension="emf" ContentType="image/x-emf"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>` },
    { name: '_rels/.rels', data: rels([['rId1', `${REL}/officeDocument`, 'xl/workbook.xml'], ['rId2', `${REL}/extended-properties`, 'docProps/app.xml']]) },
    { name: 'docProps/app.xml', data: `${DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Excel</Application></Properties>` },
    { name: 'xl/workbook.xml', data: `${DECL}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_R}"><sheets><sheet name="الصور" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: rels([['rId1', `${REL}/worksheet`, 'worksheets/sheet1.xml'], ['rId2', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/sheetMetadata', 'metadata.xml'], ['rId3', 'http://schemas.microsoft.com/office/2017/06/relationships/rdRichValue', 'richData/rdrichvalue.xml'], ['rId4', 'http://schemas.microsoft.com/office/2017/06/relationships/rdRichValueStructure', 'richData/rdrichvaluestructure.xml'], ['rId5', 'http://schemas.microsoft.com/office/2022/10/relationships/richValueRel', 'richData/richValueRel.xml'], ['rId6', 'http://schemas.microsoft.com/office/2020/07/relationships/rdRichValueWebImage', 'richData/rdRichValueWebImage.xml']]) },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
    { name: 'xl/worksheets/_rels/sheet1.xml.rels', data: rels([['rId1', `${REL}/drawing`, '../drawings/drawing1.xml']]) },
    { name: 'xl/drawings/drawing1.xml', data: drawing },
    { name: 'xl/drawings/_rels/drawing1.xml.rels', data: rels([['rId1', `${REL}/image`, '../media/image1.png'], ['rId2', `${REL}/image`, '../media/image2.emf'], ['rId3', `${REL}/image`, 'https://example.com/linked.png', 'External']]) },
    { name: 'xl/metadata.xml', data: metadata },
    { name: 'xl/richData/rdrichvalue.xml', data: richValues },
    { name: 'xl/richData/rdrichvaluestructure.xml', data: structures },
    { name: 'xl/richData/richValueRel.xml', data: richRels },
    { name: 'xl/richData/_rels/richValueRel.xml.rels', data: rels([['rId1', `${REL}/image`, '../media/image3.png'], ['rId2', `${REL}/image`, '../media/image2.emf']]) },
    { name: 'xl/richData/rdRichValueWebImage.xml', data: web },
    { name: 'xl/richData/_rels/rdRichValueWebImage.xml.rels', data: rels([['rId1', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink', 'https://example.com/photo.png', 'External']]) },
    { name: 'xl/media/image1.png', data: PNG, deflate: false },
    { name: 'xl/media/image2.emf', data: EMF, deflate: false },
    { name: 'xl/media/image3.png', data: PNG, deflate: false },
  ])
}

