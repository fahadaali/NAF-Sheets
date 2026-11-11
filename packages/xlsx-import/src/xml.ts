// A small, strict XML reader for the parts of an .xlsx package.
//
// Why not a library: the Worker has no DOMParser, and the parts are
// machine-written SpreadsheetML (ECMA-376) — elements, attributes, text,
// CDATA, comments and processing instructions. What this reader refuses is
// the point of having our own:
//   * any `<!DOCTYPE …>` or `<!ENTITY …>`: no DTD is ever processed, so no
//     entity expansion ("billion laughs") and no external entity can happen;
//   * any named entity other than the five XML predefines them.
// Character references (`&#…;`) are decoded, limited to valid code points.
//
// Two interfaces: `parseXmlEvents` streams start/end/text events (worksheets
// and shared strings, which can be large, are read this way without building a
// tree), and `parseXmlTree` builds a small tree for everything else.
//
// Names: `name` is the local name (prefix dropped: `x14:dataValidation` →
// `dataValidation`), `qname` the name as written. Attribute maps hold both the
// qualified name and, when no other attribute has it, the local name
// (`r:id` is found as `r:id` and as `id`).

import { XlsxImportError } from './errors'

export type XmlAttributes = Record<string, string>

export interface XmlHandler {
  open(name: string, attrs: XmlAttributes, qname: string, selfClosing: boolean): void
  close(name: string, qname: string): void
  text(text: string): void
}

const PREDEFINED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function corrupt(detail: string): never {
  throw new XlsxImportError('corrupt', detail)
}

/** Decodes the five predefined entities and character references; refuses anything else. */
export function decodeEntities(text: string): string {
  if (text.indexOf('&') === -1) return text
  return text.replace(/&([^;&\s]{0,32});/g, (_m, name: string) => {
    if (name.startsWith('#')) {
      const hex = name[1] === 'x' || name[1] === 'X'
      const digits = hex ? name.slice(2) : name.slice(1)
      if (!(hex ? /^[0-9a-fA-F]{1,6}$/ : /^[0-9]{1,7}$/).test(digits)) corrupt(`bad character reference &${name};`)
      const code = Number.parseInt(digits, hex ? 16 : 10)
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || code === 0) corrupt(`invalid character reference &${name};`)
      return String.fromCodePoint(code)
    }
    const value = PREDEFINED[name]
    if (value === undefined) corrupt(`undeclared entity &${name};`)
    return value
  })
}

function localName(qname: string): string {
  const colon = qname.indexOf(':')
  return colon === -1 ? qname : qname.slice(colon + 1)
}

const NAME_END = /[\s/>]/

/** Streams `xml` to `handler`. Throws `XlsxImportError('corrupt')` on malformed input or any DTD. */
export function parseXmlEvents(xml: string, handler: XmlHandler): void {
  const n = xml.length
  let i = 0
  const stack: string[] = []
  let rootSeen = false
  if (xml.charCodeAt(0) === 0xfeff) i = 1
  while (i < n) {
    const lt = xml.indexOf('<', i)
    if (lt === -1) {
      const tail = xml.slice(i)
      if (tail.trim() !== '') {
        if (stack.length === 0) corrupt('text outside the root element')
        handler.text(decodeEntities(tail))
      }
      break
    }
    if (lt > i) {
      const raw = xml.slice(i, lt)
      if (stack.length > 0) handler.text(decodeEntities(raw))
      else if (raw.trim() !== '') corrupt('text outside the root element')
    }
    const next = xml.charCodeAt(lt + 1)
    if (next === 0x3f /* ? */) {
      const end = xml.indexOf('?>', lt + 2)
      if (end === -1) corrupt('unterminated processing instruction')
      i = end + 2
      continue
    }
    if (next === 0x21 /* ! */) {
      if (xml.startsWith('<!--', lt)) {
        const end = xml.indexOf('-->', lt + 4)
        if (end === -1) corrupt('unterminated comment')
        i = end + 3
        continue
      }
      if (xml.startsWith('<![CDATA[', lt)) {
        const end = xml.indexOf(']]>', lt + 9)
        if (end === -1) corrupt('unterminated CDATA')
        if (stack.length === 0) corrupt('CDATA outside the root element')
        handler.text(xml.slice(lt + 9, end))
        i = end + 3
        continue
      }
      // <!DOCTYPE …>, <!ENTITY …> or anything else: never processed.
      throw new XlsxImportError('corrupt', 'document type declarations are not accepted')
    }
    if (next === 0x2f /* / */) {
      const end = xml.indexOf('>', lt + 2)
      if (end === -1) corrupt('unterminated end tag')
      const qname = xml.slice(lt + 2, end).trim()
      const open = stack.pop()
      if (open !== qname) corrupt(`mismatched end tag </${qname}>`)
      handler.close(localName(qname), qname)
      i = end + 1
      continue
    }
    // Start tag.
    let j = lt + 1
    while (j < n && !NAME_END.test(xml[j] as string)) j++
    const qname = xml.slice(lt + 1, j)
    if (qname === '') corrupt('empty element name')
    const attrs: XmlAttributes = {}
    const locals: Record<string, string> = {}
    let selfClosing = false
    for (;;) {
      while (j < n && /\s/.test(xml[j] as string)) j++
      if (j >= n) corrupt('unterminated start tag')
      const ch = xml[j]
      if (ch === '>') {
        j++
        break
      }
      if (ch === '/') {
        if (xml[j + 1] !== '>') corrupt('bad self-closing tag')
        selfClosing = true
        j += 2
        break
      }
      const eq = xml.indexOf('=', j)
      if (eq === -1) corrupt('attribute without value')
      const attrName = xml.slice(j, eq).trim()
      let q = eq + 1
      while (q < n && /\s/.test(xml[q] as string)) q++
      const quote = xml[q]
      if (quote !== '"' && quote !== "'") corrupt('unquoted attribute value')
      const close = xml.indexOf(quote, q + 1)
      if (close === -1) corrupt('unterminated attribute value')
      const value = decodeEntities(xml.slice(q + 1, close))
      attrs[attrName] = value
      const local = localName(attrName)
      if (local !== attrName) locals[local] = value
      j = close + 1
    }
    for (const [local, value] of Object.entries(locals)) if (!(local in attrs)) attrs[local] = value
    if (stack.length === 0) {
      if (rootSeen) corrupt('more than one root element')
      rootSeen = true
    }
    handler.open(localName(qname), attrs, qname, selfClosing)
    if (selfClosing) handler.close(localName(qname), qname)
    else stack.push(qname)
    i = j
  }
  if (stack.length > 0) corrupt(`unclosed element <${stack[stack.length - 1]}>`)
}

export interface XmlNode {
  name: string
  qname: string
  attrs: XmlAttributes
  children: XmlNode[]
  /** Text directly inside this element (not its children's), concatenated. */
  text: string
}

/** The whole document as a tree; returns the root element. */
export function parseXmlTree(xml: string): XmlNode {
  const root: XmlNode = { name: '#document', qname: '#document', attrs: {}, children: [], text: '' }
  const stack: XmlNode[] = [root]
  parseXmlEvents(xml, {
    open(name, attrs, qname) {
      const node: XmlNode = { name, qname, attrs, children: [], text: '' }
      ;(stack[stack.length - 1] as XmlNode).children.push(node)
      stack.push(node)
    },
    close() {
      stack.pop()
    },
    text(text) {
      ;(stack[stack.length - 1] as XmlNode).text += text
    },
  })
  const first = root.children[0]
  if (!first) corrupt('empty document')
  return first
}

/** First child element with local name `name`. */
export function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find((c) => c.name === name)
}

/** Every child element with local name `name`. */
export function children(node: XmlNode | undefined, name: string): XmlNode[] {
  return node ? node.children.filter((c) => c.name === name) : []
}

/** Every descendant element with local name `name`, in document order. */
export function descendants(node: XmlNode | undefined, name: string): XmlNode[] {
  const out: XmlNode[] = []
  const walk = (n: XmlNode) => {
    for (const c of n.children) {
      if (c.name === name) out.push(c)
      walk(c)
    }
  }
  if (node) walk(node)
  return out
}

/** All text of an element and its descendants, in document order. */
export function deepText(node: XmlNode | undefined): string {
  if (!node) return ''
  let out = node.text
  for (const c of node.children) out += deepText(c)
  return out
}
