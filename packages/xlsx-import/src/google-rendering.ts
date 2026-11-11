// Dropdown chips as Google Sheets itself renders a public file.
//
// Google's .xlsx export keeps a dropdown's items but drops what Google shows
// on top of them: the chip colour of each item and the display style (chip,
// arrow, plain text). Verified on 2026-11-11 with real public files: the
// Ablebits sample (1lL8K942Vj67ESDgeqOKvCED3yo6IOqerSoP9fbG8JJc) shows green,
// amber and red chips on its htmlview page, and its export carries neither a
// conditional format nor a dxf for them. The Sheets API (discovery revision
// 20261109) has no field for them either.
//
// The public page `…/htmlview/sheet?headers=true&gid=<gid>` (no account, the
// same "anyone with the link" access as the export) draws every chip as
//
//   <td class="s7"><span class="s8" style="background-color: #d4edbc; color: #11734b;
//       width: 152.0px; max-width: 152.0px; margin-left: 6.0px; padding: 1.0px 5.0px …">Yes</span></td>
//
// in a table whose header cells carry the column (`<th id="<gid>C3">`) and
// whose row headers carry the row (`<th id="<gid>R5">`). An uncoloured chip is
// #e8eaed on #000000. A multiple selection is one chip holding the joined
// text ("Product B, Product D") in the default colour. The sheet list is on
// `…/htmlview` as `items.push({name: "…", pageUrl: "…", gid: "…"})`.
//
// This is Google's page, not an API: it is read defensively (a page that does
// not parse yields nothing, never an error) and only adds to what the export
// already gave. The fetching lives in apps/api (src/xlsx-import/google-html.ts).

import { GOOGLE_DEFAULT_CHIP_COLOR, type GsCellData, type GsDataValidationRule, type GsSpreadsheet } from '@naf-sheets/gsheets-import'

/** One chip Google drew. Row and column are 0-based. */
export interface RenderedChip {
  row: number
  column: number
  text: string
  /** `#rrggbb`, lower case. */
  background: string
  /** `#rrggbb`, lower case. */
  color: string
}

/** Chips per sheet name. A sheet that is missing was not read. */
export type GoogleRendering = ReadonlyMap<string, readonly RenderedChip[]>

export interface RenderedSheet {
  name: string
  gid: string
}

/** Decodes the escapes Google's page uses in its JavaScript strings. */
function unescapeJs(s: string): string {
  return s.replace(/\\(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|(.))/g, (_m, hex: string | undefined, uni: string | undefined, ch: string | undefined) => {
    if (hex) return String.fromCharCode(parseInt(hex, 16))
    if (uni) return String.fromCharCode(parseInt(uni, 16))
    if (ch === 'n') return '\n'
    if (ch === 't') return '\t'
    return ch ?? ''
  })
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeHtml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, code: string) => {
    if (code.startsWith('#x')) return String.fromCodePoint(parseInt(code.slice(2), 16))
    if (code.startsWith('#')) return String.fromCodePoint(Number(code.slice(1)))
    return ENTITIES[code] ?? m
  })
}

/** The sheets listed on `…/htmlview`, in order. */
export function parseGoogleSheetIndex(html: string): RenderedSheet[] {
  const out: RenderedSheet[] = []
  const re = /items\.push\(\{name:\s*"((?:[^"\\]|\\.)*)",\s*pageUrl:\s*"(?:[^"\\]|\\.)*",\s*gid:\s*"(\d+)"/g
  for (const m of html.matchAll(re)) out.push({ name: unescapeJs(m[1] as string), gid: m[2] as string })
  return out
}

function hexColor(style: string, property: string): string | null {
  const m = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*(#[0-9a-fA-F]{6})\\b`).exec(style)
  return m ? (m[1] as string).toLowerCase() : null
}

/**
 * Chips on one `…/htmlview/sheet?headers=true&gid=…` page. Coordinates come
 * from the header ids, so hidden rows or columns and merged cells (colspan,
 * rowspan) do not shift them.
 */
export function parseGoogleSheetChips(html: string): RenderedChip[] {
  const table = /<table\b[^>]*class="waffle[^"]*"[^>]*>([\s\S]*?)<\/table>/.exec(html)?.[1]
  if (!table) return []
  const thead = /<thead>([\s\S]*?)<\/thead>/.exec(table)?.[1] ?? ''
  const columns: number[] = []
  for (const m of thead.matchAll(/<th\b[^>]*\bid="\d+C(\d+)"/g)) columns.push(Number(m[1]))
  if (columns.length === 0) return []
  const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(table)?.[1] ?? ''
  const chips: RenderedChip[] = []
  // Slots still taken by a cell with rowspan from a row above: "row:slot".
  const taken = new Set<string>()
  for (const tr of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
    const rowHtml = tr[1] as string
    const rowId = /<th\b[^>]*\bid="\d+R(\d+)"/.exec(rowHtml)
    if (!rowId) continue
    const row = Number(rowId[1])
    let slot = 0
    for (const td of rowHtml.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/g)) {
      while (taken.has(`${row}:${slot}`)) slot++
      const attrs = td[1] as string
      const colspan = Math.max(1, Number(/\bcolspan="(\d+)"/.exec(attrs)?.[1] ?? 1))
      const rowspan = Math.max(1, Number(/\browspan="(\d+)"/.exec(attrs)?.[1] ?? 1))
      const column = columns[slot]
      for (let dr = 1; dr < rowspan; dr++) for (let dc = 0; dc < colspan; dc++) taken.add(`${row + dr}:${slot + dc}`)
      slot += colspan
      if (column === undefined) continue
      const span = /^\s*<span\b[^>]*\bstyle="([^"]*)"[^>]*>([\s\S]*?)<\/span>\s*$/.exec(td[2] as string)
      if (!span) continue
      const style = span[1] as string
      // A chip, not a run of rich text: a filled box with a fixed width and padding.
      if (!/max-width\s*:/.test(style) || !/padding\s*:/.test(style)) continue
      const background = hexColor(style, 'background-color')
      const color = hexColor(style, 'color')
      if (!background || !color) continue
      // An empty dropdown cell is drawn as a chip holding U+200B (real pages): no item.
      const text = decodeHtml((span[2] as string).replace(/<[^>]*>/g, '')).replace(/[\u200b\u200c\u200d\ufeff]/g, '').trim()
      if (text === '') continue
      chips.push({ row, column, text, background, color })
    }
  }
  return chips
}

/** Whether a cell's rule is a dropdown list. */
function isListRule(rule: GsDataValidationRule | undefined): rule is GsDataValidationRule {
  const t = rule?.condition?.type
  return t === 'ONE_OF_LIST' || t === 'ONE_OF_RANGE'
}

/** Names of the sheets that hold at least one dropdown. */
export function sheetsWithDropdowns(spreadsheet: GsSpreadsheet): string[] {
  const out: string[] = []
  for (const sheet of spreadsheet.sheets ?? []) {
    const has = (sheet.data ?? []).some((block) => block.rowData?.some((row) => row.values?.some((cell) => isListRule(cell?.dataValidation))))
    if (has && sheet.properties?.title) out.push(sheet.properties.title)
  }
  return out
}

/**
 * Adds what Google rendered to the dropdown rules of `spreadsheet` (in place):
 * a rule whose cells show chips gets display style CHIP, and the colour of
 * every item seen alone in a chip (the default grey included, which tells the
 * converter the item was seen and has no colour). Returns the sheets that
 * hold dropdowns but were not in `rendering`.
 */
export function applyGoogleRendering(spreadsheet: GsSpreadsheet, rendering: GoogleRendering): string[] {
  const missing: string[] = []
  for (const sheet of spreadsheet.sheets ?? []) {
    const name = sheet.properties?.title ?? ''
    const chips = rendering.get(name)
    const cellsByRule = new Map<GsDataValidationRule, Array<[number, number]>>()
    for (const block of sheet.data ?? []) {
      const r0 = block.startRow ?? 0
      const c0 = block.startColumn ?? 0
      block.rowData?.forEach((row, i) =>
        row.values?.forEach((cell: GsCellData | undefined, j) => {
          const rule = cell?.dataValidation
          if (!isListRule(rule)) return
          const list = cellsByRule.get(rule) ?? []
          list.push([r0 + i, c0 + j])
          cellsByRule.set(rule, list)
        }),
      )
    }
    if (cellsByRule.size === 0) continue
    if (!chips) {
      missing.push(name)
      continue
    }
    const at = new Map(chips.map((c) => [`${c.row}:${c.column}`, c]))
    for (const [rule, cells] of cellsByRule) {
      const seen: Record<string, string> = {}
      let anyChip = false
      for (const [r, c] of cells) {
        const chip = at.get(`${r}:${c}`)
        if (!chip) continue
        anyChip = true
        // A coloured sighting wins over a grey one (the same item cannot be both).
        if (seen[chip.text] === undefined || seen[chip.text] === GOOGLE_DEFAULT_CHIP_COLOR) seen[chip.text] = chip.background
      }
      if (!anyChip) continue
      rule.naf = { ...rule.naf, displayStyle: 'CHIP', itemColors: { ...rule.naf?.itemColors, ...seen } }
    }
  }
  return missing
}
