// Pagination (README "Pagination"): follow the `Link` header's rel="next" URL
// verbatim. Page URLs are never built by hand.

export interface Page<T> {
  items: T[]
  /** `X-Total-Count` when Basecamp sent it. */
  totalCount: number | null
}

/**
 * A lazily fetched paginated collection. Iterate it with `for await`, or
 * collect every item with `all()`. Nothing is requested until one of them runs,
 * and each run starts again from the first page.
 */
export interface Paged<T> extends AsyncIterable<T> {
  all(): Promise<T[]>
  pages(): AsyncIterable<Page<T>>
}

/**
 * The URL of the rel="next" link in an RFC 8288 `Link` header, or null.
 * Handles several comma-separated links, quoted or bare `rel`, and `rel`
 * lists such as `rel="next last"`.
 */
export function parseNextLink(header: string | null): string | null {
  if (!header) return null
  const linkPattern = /<([^>]*)>((?:\s*;\s*[^;,]+)*)/g
  let match: RegExpExecArray | null
  while ((match = linkPattern.exec(header)) !== null) {
    const url = match[1] ?? ''
    const params = match[2] ?? ''
    for (const param of params.split(';')) {
      const eq = param.indexOf('=')
      if (eq < 0) continue
      const name = param.slice(0, eq).trim().toLowerCase()
      if (name !== 'rel') continue
      const value = param
        .slice(eq + 1)
        .trim()
        .replace(/^"(.*)"$/, '$1')
      if (value.toLowerCase().split(/\s+/).includes('next')) return url.trim() || null
    }
  }
  return null
}

export function parseTotalCount(header: string | null): number | null {
  if (header === null || !/^\s*\d+\s*$/.test(header)) return null
  return Number(header.trim())
}

/** Build a `Paged<T>` from a page producer. */
export function makePaged<T>(pages: () => AsyncIterable<Page<T>>): Paged<T> {
  return {
    pages,
    async *[Symbol.asyncIterator]() {
      for await (const page of pages()) {
        for (const item of page.items) yield item
      }
    },
    async all() {
      const out: T[] = []
      for await (const page of pages()) out.push(...page.items)
      return out
    },
  }
}
