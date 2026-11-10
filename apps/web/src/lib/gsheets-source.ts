// What the user pastes into «استيراد من Google Sheets» (spec §7.2): a Google
// Sheets address or a bare spreadsheet id. Checked in the browser so an
// obvious mistake gets an Arabic explanation before any request; the API
// checks again (`ImportGsheetsRequest.source`). Pure, unit-tested.

export type SourceProblem =
  /** Nothing was pasted. */
  | 'empty'
  /** An address, but not of a Google Sheets file (Drive, Docs, another site, http…). */
  | 'not_sheets'
  /** A "publish to the web" address (`/spreadsheets/d/e/…`): it carries no spreadsheet id. */
  | 'published'
  /** Neither an address nor something shaped like a spreadsheet id. */
  | 'invalid_id'

export type SourceCheck = { ok: true; spreadsheetId: string } | { ok: false; problem: SourceProblem }

// Spreadsheet ids are URL-safe base64 (today 44 characters). The lower bound
// keeps a stray word from passing as an id; the API is the final judge.
const ID = /^[A-Za-z0-9_-]{25,128}$/
// /spreadsheets/d/<id>, optionally under a signed-in user (/u/1/).
const SHEETS_PATH = /^\/spreadsheets\/(?:u\/\d+\/)?d\/([^/]+)(?:\/.*)?$/

export function parseSpreadsheetSource(input: string): SourceCheck {
  const text = input.trim()
  if (text === '') return { ok: false, problem: 'empty' }
  if (ID.test(text)) return { ok: true, spreadsheetId: text }

  const looksLikeAddress = text.includes('/') || text.includes('.') || text.includes(':')
  if (!looksLikeAddress) return { ok: false, problem: 'invalid_id' }

  // Copied without the scheme ("docs.google.com/spreadsheets/d/…").
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return { ok: false, problem: 'not_sheets' }
  }
  if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com' || url.username || url.password || url.port) {
    return { ok: false, problem: 'not_sheets' }
  }
  const match = SHEETS_PATH.exec(url.pathname)
  if (!match?.[1]) return { ok: false, problem: 'not_sheets' }
  if (match[1] === 'e') return { ok: false, problem: 'published' }
  let id: string
  try {
    id = decodeURIComponent(match[1])
  } catch {
    return { ok: false, problem: 'invalid_id' }
  }
  return ID.test(id) ? { ok: true, spreadsheetId: id } : { ok: false, problem: 'invalid_id' }
}
