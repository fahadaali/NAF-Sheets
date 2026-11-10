// Cell rich text (`ICellData.p`, an IDocumentData) for:
//   - textFormatRuns (spec §7.2 "textFormatRuns → نص غني"),
//   - hyperlinks: Univer 1.4.0 keeps cell links only as HYPERLINK custom
//     ranges inside `p` (sheets-hyper-link/lib/es/index.js: AddHyperLinkCommand
//     and the AFTER_CELL_EDIT interceptor build exactly this; the plugin
//     registers no resource of its own),
//   - multi-line text: Univer draws a plain `v` string through
//     extractPureTextFromCell, which strips `\r` and `\n` (core
//     lib/es/index.js), so line breaks survive only as paragraphs in `p`.
//
// Document layout (core i-document-data.d.ts, docs.univer.ai docs/model/
// text-runs-and-paragraphs): `\r` ends a paragraph, `\n` a section; a cell
// document is `text + "\r\n"`. ITextRun.ed is exclusive, ICustomRange.endIndex
// inclusive. Google run indexes are UTF-16 code units, like JS strings, so
// they are used as they are. Cell style `s` does not reach the runs of `p`
// (Worksheet.getCellDocumentModel uses `p` as stored), so every run carries
// its fully resolved text style.

import type { ICustomRange, IDocumentData, IParagraph, ITextRun, ITextStyle } from '@univerjs/core'
import { CUSTOM_RANGE_HYPERLINK } from './univer-constants'

export interface TextSegment {
  /** Inclusive start, UTF-16 index into the cell text. */
  start: number
  /** Exclusive end. */
  end: number
  style: ITextStyle
  link: string | null
}

/**
 * Builds the cell document. `segments` must cover the text in order without
 * gaps; segments with an empty style produce no text run, adjacent segments
 * with the same link produce one custom range.
 */
export function buildCellDocument(text: string, segments: readonly TextSegment[], idPrefix: string): IDocumentData {
  const dataStream = `${text.replace(/\n/g, '\r')}\r\n`

  const paragraphs: IParagraph[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') paragraphs.push({ startIndex: i, paragraphId: `p${paragraphs.length}` })
  }
  paragraphs.push({ startIndex: text.length, paragraphId: `p${paragraphs.length}` })

  const textRuns: ITextRun[] = []
  for (const seg of segments) {
    if (seg.end <= seg.start) continue
    if (Object.keys(seg.style).length === 0) continue
    textRuns.push({ st: seg.start, ed: seg.end, ts: seg.style })
  }

  const customRanges: ICustomRange[] = []
  let open: { url: string; start: number; end: number } | null = null
  const flush = () => {
    if (!open) return
    customRanges.push({
      startIndex: open.start,
      endIndex: open.end - 1,
      rangeId: `${idPrefix}-link${customRanges.length}`,
      rangeType: CUSTOM_RANGE_HYPERLINK,
      properties: { url: open.url },
    })
    open = null
  }
  for (const seg of segments) {
    if (seg.end <= seg.start) continue
    if (seg.link && open && open.url === seg.link && open.end === seg.start) {
      open.end = seg.end
      continue
    }
    flush()
    if (seg.link) open = { url: seg.link, start: seg.start, end: seg.end }
  }
  flush()

  const body: IDocumentData['body'] = {
    dataStream,
    paragraphs,
    sectionBreaks: [{ sectionId: 's0', startIndex: text.length + 1 }],
  }
  if (textRuns.length > 0) body.textRuns = textRuns
  if (customRanges.length > 0) body.customRanges = customRanges
  return { id: 'd', body, documentStyle: {} }
}

/** The plain text of a cell document (paragraph breaks back to `\n`, trailing `\r\n` removed). */
export function documentPlainText(doc: IDocumentData): string {
  const stream = doc.body?.dataStream ?? ''
  return stream.replace(/\r\n$/, '').replace(/\r/g, '\n')
}
