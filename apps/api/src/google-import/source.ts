// `ImportGsheetsRequest.source`: a Google Sheets URL or a bare spreadsheet id.
//
// Google's concepts page: the id is "a particular string containing letters,
// numbers, and some special characters … derived from the spreadsheet's URL",
// e.g. https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit?gid=SHEET_ID#gid=SHEET_ID
//
// Accepted:
//   https://docs.google.com/spreadsheets/d/<id>[/anything][?query][#fragment]
//   https://docs.google.com/spreadsheets/u/<n>/d/<id>…   (signed in with several accounts)
//   the same without "https://"
//   <id>
// Refused (narrowest): any other host (drive.google.com links may point at an
// uploaded .xlsx the Sheets API cannot read), plain http, and "published to
// the web" links (/spreadsheets/d/e/<publish id>/…), whose id is not a
// spreadsheet id.

/**
 * Characters seen in spreadsheet ids (letters, digits, `-`, `_`).
 * OPEN: Google documents no length; ids are 44 characters in practice. 20–200
 * keeps typos and stray words out without guessing an exact length
 * (OPEN_QUESTIONS.md "Google import" G6).
 */
const SPREADSHEET_ID = /^[A-Za-z0-9_-]{20,200}$/

const MAX_SOURCE_LENGTH = 2048

/** The spreadsheet id, or null when `source` is neither a Sheets URL nor an id. */
export function parseSpreadsheetSource(source: unknown): string | null {
  if (typeof source !== 'string') return null
  const text = source.trim()
  if (text === '' || text.length > MAX_SOURCE_LENGTH) return null

  if (SPREADSHEET_ID.test(text)) return text

  const withScheme = /^docs\.google\.com\//i.test(text) ? `https://${text}` : text
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'docs.google.com') return null
  if (url.username !== '' || url.password !== '' || url.port !== '') return null

  const match = /^\/spreadsheets\/(?:u\/\d+\/)?d\/([^/]+)(?:\/|$)/.exec(url.pathname)
  const id = match?.[1]
  if (!id || id === 'e') return null
  return SPREADSHEET_ID.test(id) ? id : null
}
