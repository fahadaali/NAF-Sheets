// Which program wrote the .xlsx. The reader normalises a few things per
// origin (column widths, checkboxes, Google's function wrappers); everything
// else is the same SpreadsheetML.
//
// Signals, each verified on real files (2026-11-11):
//   Google export (four public sheets exported through
//   docs.google.com/…/export?format=xlsx): no docProps/ parts at all (no
//   app.xml, no core.xml); workbook.xml declares the Mac Excel namespaces
//   `xmlns:mx="http://schemas.microsoft.com/office/mac/excel/2008/main"` and
//   `xmlns:mv="urn:schemas-microsoft-com:mac:vml"`; an empty
//   xl/persons/person.xml; the theme, when present, is named "Sheets".
//   Excel: docProps/app.xml `<Application>Microsoft Excel</Application>`
//   (ECMA-376 Part 1 §22.2.2.3). No Excel was available here, so the Excel
//   side of this check is from the specification, not from a file Excel wrote.
//   Others write their own name there: openpyxl 3.1.5 writes
//   "Microsoft Excel Compatible / Openpyxl 3.1.5" (checked),
//   LibreOffice "LibreOffice/<version>…" (checked with LibreOffice here).
//
// A file a person downloaded from Google Sheets (File → Download → .xlsx) is
// the same export as the platform's own download, so it is recognised the
// same way.

import type { ImportOriginKind } from '@naf-sheets/gsheets-import'

export interface OriginSignals {
  /** <Application> of docProps/app.xml, or null when the part is missing. */
  application: string | null
  hasDocProps: boolean
  workbookNamespaces: string[]
  themeName: string | null
  hasPersonsPart: boolean
  /** A formula with Google's `__xludf.DUMMYFUNCTION` wrapper was seen. */
  googleDummyFunction: boolean
}

export interface DetectedOrigin {
  kind: Exclude<ImportOriginKind, 'google_api'>
  application: string | null
  /** The signals that decided, for the report and the audit (no file content). */
  evidence: string[]
}

const MAC_EXCEL_NS = 'http://schemas.microsoft.com/office/mac/excel/2008/main'
const MAC_VML_NS = 'urn:schemas-microsoft-com:mac:vml'

export function detectOrigin(s: OriginSignals): DetectedOrigin {
  const app = s.application?.trim() || null
  if (app && /^Microsoft (Macintosh )?Excel$/i.test(app)) {
    return { kind: 'excel', application: app, evidence: ['docProps/app.xml'] }
  }
  const google: string[] = []
  if (!s.hasDocProps) google.push('no docProps')
  if (s.workbookNamespaces.includes(MAC_EXCEL_NS) && s.workbookNamespaces.includes(MAC_VML_NS)) google.push('workbook namespaces')
  if (s.themeName === 'Sheets') google.push('theme "Sheets"')
  if (s.hasPersonsPart && !s.hasDocProps) google.push('persons part')
  if (s.googleDummyFunction) google.push('DUMMYFUNCTION')
  // Without docProps every other writer we know still names itself; two
  // Google signals together (or the DUMMYFUNCTION wrapper) decide.
  if (!app && (google.length >= 2 || s.googleDummyFunction)) return { kind: 'google_export', application: null, evidence: google }
  return { kind: 'other', application: app, evidence: app ? ['docProps/app.xml'] : google }
}
