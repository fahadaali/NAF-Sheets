// Files in a to-do's description (phase 5, spec §10, §8.2).
//
// bc-api rich_text.md: a file uploaded with `POST /attachments.json` is put
// into rich text as `<bc-attachment sgid="…"></bc-attachment>`. These helpers
// find, add and remove such elements in the HUMAN part of a description (the
// part before the managed block). Nothing else in the HTML is touched: what
// they do not add or remove is kept byte for byte.
//
// Decided here (OPEN, apps/api/OPEN_QUESTIONS.md P1): a file uploaded from the
// platform goes at the END OF THE PERSON'S PART, not into the managed block.
// Spec §8.2 keeps "what precedes the block verbatim, attachments included" —
// files are expected there — while the block is rewritten whole and compared
// by its visible text, which a file has none of. A file in the person's part
// is also what Basecamp shows for a file a person attached there.

import { decodeBasicEntities } from './html'

/** One `<bc-attachment>` element found in an HTML fragment. */
export interface AttachmentElement {
  /** Offsets of the element in the fragment (`html.slice(start, end)` is it). */
  start: number
  end: number
  /** The element's markup, exactly as found. */
  html: string
  /** `sgid` attribute; null when missing. */
  sgid: string | null
  /** `filename` attribute when Basecamp wrote one (not documented: a fallback name only). */
  filename: string | null
}

// The opening tag with quoted attribute values (which may hold `>`), then
// either `/>` or a body up to the first closing tag.
const OPENING = String.raw`<bc-attachment\b(?:[^>"']|"[^"]*"|'[^']*')*?`
const ELEMENT = new RegExp(`${OPENING}(?:\\/>|>[\\s\\S]*?<\\/bc-attachment\\s*>)`, 'gi')
const OPEN_TAG = new RegExp(`${OPENING}\\/?>`, 'i')

function attribute(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>/]+))`, 'i').exec(tag)
  if (!m) return null
  const value = decodeBasicEntities(m[1] ?? m[2] ?? m[3] ?? '')
  return value === '' ? null : value
}

/** Every `<bc-attachment>` element of `html`, in document order. */
export function findAttachmentElements(html: string | null | undefined): AttachmentElement[] {
  const text = html ?? ''
  const out: AttachmentElement[] = []
  for (const m of text.matchAll(ELEMENT)) {
    const element = m[0]
    const tag = OPEN_TAG.exec(element)?.[0] ?? element
    out.push({ start: m.index, end: m.index + element.length, html: element, sgid: attribute(tag, 'sgid'), filename: attribute(tag, 'filename') })
  }
  return out
}

/** The distinct `sgid`s of the files in `html`, in document order. */
export function attachmentSgids(html: string | null | undefined): string[] {
  const seen = new Set<string>()
  for (const e of findAttachmentElements(html)) if (e.sgid !== null) seen.add(e.sgid)
  return [...seen]
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** The element the platform writes for an uploaded file: only `sgid`, as rich_text.md documents. */
export function attachmentElementHtml(sgid: string): string {
  if (typeof sgid !== 'string' || sgid.trim() === '') throw new TypeError('an attachment needs its attachable_sgid')
  return `<bc-attachment sgid="${escapeAttribute(sgid)}"></bc-attachment>`
}

/** `human` with the file appended at its end; unchanged when the file is already in it. */
export function appendAttachment(human: string | null | undefined, sgid: string): string {
  const text = human ?? ''
  if (attachmentSgids(text).includes(sgid)) return text
  return text + attachmentElementHtml(sgid)
}

/** `html` without the elements of the file `sgid` (every copy); everything else byte for byte. */
export function removeAttachment(html: string | null | undefined, sgid: string): { html: string; removed: number } {
  const text = html ?? ''
  let out = ''
  let at = 0
  let removed = 0
  for (const e of findAttachmentElements(text)) {
    if (e.sgid !== sgid) continue
    out += text.slice(at, e.start)
    at = e.end
    removed += 1
  }
  return { html: out + text.slice(at), removed }
}

/** `html` without any file element (the text a person reads and types). */
export function withoutAttachments(html: string | null | undefined): string {
  const text = html ?? ''
  let out = ''
  let at = 0
  for (const e of findAttachmentElements(text)) {
    out += text.slice(at, e.start)
    at = e.end
  }
  return out + text.slice(at)
}

/** Only the file elements of `html`, concatenated in order ('' when there are none). */
export function attachmentElementsOf(html: string | null | undefined): string {
  return findAttachmentElements(html)
    .map((e) => e.html)
    .join('')
}
