// Small, dependency-free HTML helpers. None of them is used to *rewrite* a
// human-written description: they escape our own text, or produce a
// normalised form used only for comparison.

/** Escapes text for an HTML text node. Quotes are left as they are: they are legal in text. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/** Decodes the few entities a sanitiser is likely to introduce or remove, in one pass. */
export function decodeBasicEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

/**
 * Whitespace-insensitive form of an HTML fragment, for comparison only
 * (Basecamp may reflow whitespace and rewrite void tags). Never written back.
 * Runs of whitespace count as one space, and whitespace next to a tag does not
 * count at all; words stay separated.
 * OPEN: what else Basecamp's sanitiser rewrites is unknown until the phase 0
 * live test (`check-block`); extend this normaliser then (#11).
 */
export function normalizeHtml(html: string | null | undefined): string {
  if (!html) return ''
  return html
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/<\s*(br|hr)\s*\/?\s*>/gi, (_match, tag: string) => `<${tag.toLowerCase()}>`)
    .replace(/\s+/g, ' ')
    .replace(/\s*(<[^>]*>)\s*/g, '$1')
    .trim()
}

export function sameHtml(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalizeHtml(a) === normalizeHtml(b)
}

/**
 * The visible text of an HTML fragment, one line per line break or block
 * element, whitespace collapsed, empty lines dropped. Used to compare the
 * managed block: a sanitiser may change its markup, a person changes its text.
 */
export function htmlToComparableText(html: string | null | undefined): string {
  if (!html) return ''
  const withBreaks = html
    .replace(/<\s*(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\s*\/?\s*(div|p|li|ul|ol|h[1-6]|blockquote|pre)\b[^>]*>/gi, '\n')
  const text = decodeBasicEntities(withBreaks.replace(/<[^>]*>/g, ''))
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n')
}
