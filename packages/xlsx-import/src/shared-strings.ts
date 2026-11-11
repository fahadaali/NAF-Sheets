// sharedStrings.xml (§18.4) and inline strings: text plus rich-text runs.
// Phonetic runs (<rPh>, East Asian readings) are not part of the text.

import type { GsTextFormatRun } from '@naf-sheets/gsheets-import'
import type { XlsxColors } from './colors'
import { fontToTextFormat, readFont, type StyleSheet } from './styles'
import { parseXmlEvents, type XmlNode } from './xml'

export interface SharedString {
  text: string
  runs?: GsTextFormatRun[]
}

/** `_x000D_`-style escapes (§22.9.2.19) that writers use for control characters. */
function unescapeOoxml(text: string): string {
  return text.includes('_x') ? text.replace(/_x([0-9A-Fa-f]{4})_/g, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))) : text
}

/** Text and runs of an <si> or <is> element. */
export function richTextOf(node: XmlNode, colors: XlsxColors, styles: StyleSheet): SharedString {
  let text = ''
  const runs: GsTextFormatRun[] = []
  let rich = false
  for (const c of node.children) {
    if (c.name === 't') text += unescapeOoxml(c.text)
    else if (c.name === 'r') {
      rich = true
      const rPr = c.children.find((x) => x.name === 'rPr')
      const t = c.children.filter((x) => x.name === 't').map((x) => unescapeOoxml(x.text)).join('')
      const format = rPr ? fontToTextFormat(readFont(rPr, colors), styles.defaultFont) : undefined
      runs.push({ startIndex: text.length, format: format ?? {} })
      text += t
    }
  }
  return rich && runs.length > 0 ? { text, runs } : { text }
}

/** Streams the shared string table. */
export function readSharedStrings(xml: string, colors: XlsxColors, styles: StyleSheet): SharedString[] {
  const out: SharedString[] = []
  let si: XmlNode | null = null
  const stack: XmlNode[] = []
  let skip = 0
  parseXmlEvents(xml, {
    open(name, attrs, qname) {
      if (skip > 0) {
        skip++
        return
      }
      if (name === 'si') {
        si = { name, qname, attrs, children: [], text: '' }
        stack.length = 0
        stack.push(si)
        return
      }
      if (!si) return
      if (name === 'rPh' || name === 'phoneticPr') {
        skip = 1
        return
      }
      const node: XmlNode = { name, qname, attrs, children: [], text: '' }
      ;(stack[stack.length - 1] as XmlNode).children.push(node)
      stack.push(node)
    },
    close(name) {
      if (skip > 0) {
        skip--
        return
      }
      if (!si) return
      if (name === 'si' && stack.length === 1) {
        out.push(richTextOf(si, colors, styles))
        si = null
        stack.length = 0
        return
      }
      stack.pop()
    },
    text(text) {
      if (skip > 0 || !si) return
      const node = stack[stack.length - 1]
      if (node) node.text += text
    },
  })
  return out
}
