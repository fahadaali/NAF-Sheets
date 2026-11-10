// `fields` masks for spreadsheets.get, derived from what
// @naf-sheets/gsheets-import reads (its src/convert.ts, style.ts, color.ts,
// banding.ts, conditional-format.ts, data-validation.ts, filter.ts) — field
// names as in its src/google-types.ts, which mirrors the official REST
// reference. Asking only for these keeps responses small and keeps data the
// platform has no use for (protected-range editors' emails, comment text,
// developer metadata…) out of the Worker.
//
// Syntax (Sheets "Use field masks"): "multiple different fields are
// comma-separated and subfields are dot-separated … multiple subfields from
// the same type can be listed within parentheses", e.g.
// `sheets.properties(sheetId,title,sheetType,gridProperties)`. The mask is
// written only in that documented form: one level of parentheses after a
// dotted path, never nested.
//
// "includeGridData … is ignored if a field mask was set in the request": the
// mask alone decides whether cells come back. The import still sends
// includeGridData as spec §7.2 states it (false for metadata, true for cells).
//
// Deliberately NOT requested:
//   - comments and sheets[].commentAnchors: only returned with
//     commentsViewMode=INCLUDED, which answers 403 to a user who may not view
//     comments. The report therefore does not list comments.
//     OPEN: OPEN_QUESTIONS.md "Google import" G7.
//   - protectedRanges[].editors (other people's emails), developerMetadata,
//     dataSources, dataSourceFormula, rowGroupControlAfter, timeZone… (unused).

/** A field and its subfields; `true` asks for the whole field. */
export interface MaskTree {
  [field: string]: true | MaskTree
}

/** Everything the converter reads outside the cells. Requested once, without ranges. */
export const METADATA_FIELDS: MaskTree = {
  spreadsheetId: true,
  properties: {
    title: true,
    locale: true,
    iterativeCalculationSettings: true,
    spreadsheetTheme: { themeColors: true },
  },
  namedRanges: { namedRangeId: true, name: true, range: true },
  sheets: {
    properties: {
      sheetId: true,
      title: true,
      index: true,
      sheetType: true,
      hidden: true,
      tabColor: true,
      tabColorStyle: true,
      rightToLeft: true,
      gridProperties: { rowCount: true, columnCount: true, frozenRowCount: true, frozenColumnCount: true, hideGridlines: true },
    },
    merges: true,
    conditionalFormats: { ranges: true, booleanRule: true, gradientRule: true },
    basicFilter: { range: true, tableId: true, criteria: true, filterSpecs: true },
    bandedRanges: { range: true, rowProperties: true, columnProperties: true },
    tables: { name: true, range: true },
    rowGroups: { range: { startIndex: true, endIndex: true } },
    columnGroups: { range: { startIndex: true, endIndex: true } },
    // Report-only objects. The converter reads title/range/position only; the
    // id (always set) is asked for too so an object with neither title nor
    // range still comes back and is still reported.
    filterViews: { filterViewId: true, title: true, range: true },
    protectedRanges: { protectedRangeId: true, description: true, range: true },
    charts: { chartId: true, spec: { title: true }, position: { overlayPosition: { anchorCell: true } } },
    slicers: { slicerId: true, spec: { title: true }, position: { overlayPosition: { anchorCell: true } } },
  },
}

/** Cells and row/column sizes, requested per range. `sheetId` ties each block to its sheet. */
export const GRID_FIELDS: MaskTree = {
  sheets: {
    properties: { sheetId: true },
    data: {
      startRow: true,
      startColumn: true,
      rowMetadata: { pixelSize: true, hiddenByUser: true },
      columnMetadata: { pixelSize: true, hiddenByUser: true },
      rowData: {
        values: {
          userEnteredValue: true,
          effectiveValue: true,
          formattedValue: true,
          userEnteredFormat: true,
          effectiveFormat: { numberFormat: true },
          hyperlink: true,
          note: true,
          textFormatRuns: true,
          dataValidation: true,
          // Only their presence is read (anchors of produced values); asked
          // whole so the presence cannot depend on which union member is set.
          pivotTable: true,
          dataSourceTable: true,
          chipRuns: { chip: { personProperties: { email: true }, richLinkProperties: { uri: true } } },
        },
      },
    },
  },
}

/**
 * `a`, `a(b,c)` and `a.b(c,d)` parts, comma-joined: each dotted path ends in
 * at most one parenthesised list of plain field names.
 */
export function serializeMask(tree: MaskTree): string {
  return maskParts(tree, '').join(',')
}

function maskParts(tree: MaskTree, prefix: string): string[] {
  const leaves: string[] = []
  const nested: Array<[string, MaskTree]> = []
  for (const [field, sub] of Object.entries(tree)) {
    if (sub === true) leaves.push(field)
    else nested.push([field, sub])
  }
  const parts: string[] = []
  if (leaves.length > 0) {
    if (prefix === '') parts.push(...leaves)
    else if (leaves.length === 1) parts.push(`${prefix}.${leaves[0]}`)
    else parts.push(`${prefix}(${leaves.join(',')})`)
  }
  for (const [field, sub] of nested) parts.push(...maskParts(sub, prefix === '' ? field : `${prefix}.${field}`))
  return parts
}

export const METADATA_MASK = serializeMask(METADATA_FIELDS)
export const GRID_MASK = serializeMask(GRID_FIELDS)
