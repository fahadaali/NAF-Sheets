// The Unicode Bidirectional Algorithm (UAX #9), for the RTL text layer.
//
// Univer 1.4.0 lays document text out in logical order, left to right, with
// no bidi stage at all (see rtl-text.ts). This module computes what the
// browser does: the embedding level of every character of a paragraph
// (rules P2-P3, X1-X10, W1-W7, N0-N2, I1-I2) and, per line, the visual order
// (L1-L2). It is pure: no DOM, no Univer.
//
// JavaScript regular expressions cannot match Bidi_Class, so `bidiClassOf`
// derives it from code point ranges and general categories. It is exact for
// the scripts and symbols NAF text uses (Arabic, Latin, digits, punctuation,
// currency) and close for the rest. Rule L4 (glyph mirroring) is left to the
// canvas, which mirrors brackets drawn with `direction = 'rtl'`.

export type BidiClass =
  | 'L' | 'R' | 'AL' | 'EN' | 'ES' | 'ET' | 'AN' | 'CS' | 'NSM' | 'BN' | 'B' | 'S' | 'WS' | 'ON'
  | 'LRE' | 'LRO' | 'RLE' | 'RLO' | 'PDF' | 'LRI' | 'RLI' | 'FSI' | 'PDI'

// Numeric codes keep the inner loops cheap.
const L = 0, R = 1, AL = 2, EN = 3, ES = 4, ET = 5, AN = 6, CS = 7, NSM = 8, BN = 9, B = 10, S = 11, WS = 12, ON = 13
const LRE = 14, LRO = 15, RLE = 16, RLO = 17, PDF = 18, LRI = 19, RLI = 20, FSI = 21, PDI = 22
const NAMES: readonly BidiClass[] = ['L', 'R', 'AL', 'EN', 'ES', 'ET', 'AN', 'CS', 'NSM', 'BN', 'B', 'S', 'WS', 'ON', 'LRE', 'LRO', 'RLE', 'RLO', 'PDF', 'LRI', 'RLI', 'FSI', 'PDI']

const ASCII: number[] = []
for (let c = 0; c < 128; c++) {
  let t = ON
  if (c <= 0x08 || (c >= 0x0e && c <= 0x1b) || c === 0x7f) t = BN
  else if (c === 0x09 || c === 0x0b || c === 0x1f) t = S
  else if (c === 0x0a || c === 0x0d || (c >= 0x1c && c <= 0x1e)) t = B
  else if (c === 0x0c || c === 0x20) t = WS
  else if (c >= 0x30 && c <= 0x39) t = EN
  else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) t = L
  else if (c === 0x23 || c === 0x24 || c === 0x25) t = ET
  else if (c === 0x2b || c === 0x2d) t = ES
  else if (c === 0x2c || c === 0x2e || c === 0x2f || c === 0x3a) t = CS
  ASCII.push(t)
}

/** True when `cp` lies in one of the inclusive [start, end] pairs of `ranges`. */
const inRanges = (cp: number, ranges: readonly number[]) => {
  for (let i = 0; i + 1 < ranges.length; i += 2) if (cp >= ranges[i]! && cp <= ranges[i + 1]!) return true
  return false
}
const EN_RANGES = [0xb2, 0xb3, 0xb9, 0xb9, 0x6f0, 0x6f9, 0x2070, 0x2070, 0x2074, 0x2079, 0x2080, 0x2089, 0x2488, 0x249b, 0xff10, 0xff19, 0x1d7ce, 0x1d7ff, 0x1f100, 0x1f10a, 0x1fbf0, 0x1fbf9]
const AN_RANGES = [0x600, 0x605, 0x660, 0x669, 0x66b, 0x66c, 0x6dd, 0x6dd, 0x890, 0x891, 0x8e2, 0x8e2, 0x10d30, 0x10d39, 0x10e60, 0x10e7e]
const ES_RANGES = [0x207a, 0x207b, 0x208a, 0x208b, 0x2212, 0x2212, 0xfb29, 0xfb29, 0xfe62, 0xfe63, 0xff0b, 0xff0b, 0xff0d, 0xff0d]
const ET_RANGES = [0xa2, 0xa5, 0xb0, 0xb1, 0x609, 0x60a, 0x66a, 0x66a, 0x9f2, 0x9f3, 0x9fb, 0x9fb, 0xaf1, 0xaf1, 0xbf9, 0xbf9, 0xe3f, 0xe3f, 0x17db, 0x17db, 0x2030, 0x2034, 0x20a0, 0x20cf, 0x212e, 0x212e, 0x2213, 0x2213, 0xa838, 0xa839, 0xfe5f, 0xfe5f, 0xfe69, 0xfe6a, 0xff03, 0xff05, 0xffe0, 0xffe1, 0xffe5, 0xffe6]
const CS_RANGES = [0xa0, 0xa0, 0x60c, 0x60c, 0x202f, 0x202f, 0x2044, 0x2044, 0xfe50, 0xfe50, 0xfe52, 0xfe52, 0xfe55, 0xfe55, 0xff0c, 0xff0c, 0xff0e, 0xff0f, 0xff1a, 0xff1a]
const WS_RANGES = [0x1680, 0x1680, 0x2000, 0x200a, 0x2028, 0x2028, 0x205f, 0x205f, 0x3000, 0x3000]
const B_RANGES = [0x85, 0x85, 0x2029, 0x2029]
const BN_RANGES = [0x80, 0x84, 0x86, 0x9f, 0xad, 0xad, 0x180e, 0x180e, 0x200b, 0x200d, 0x2060, 0x2064, 0x206a, 0x206f, 0xfeff, 0xfeff]
// Symbols inside the right-to-left blocks that are neutral (ON) rather than strong.
const RTL_BLOCK_ON = [0x606, 0x607, 0x60e, 0x60f, 0x6de, 0x6de, 0x6e9, 0x6e9, 0x7f6, 0x7f9, 0xfd3e, 0xfd3f, 0xfdcf, 0xfdcf, 0xfdfd, 0xfdff, 0x1eef0, 0x1eef1]
// Strong right-to-left blocks: Arabic-type (AL) and the others (R).
const AL_BLOCKS = [0x600, 0x7bf, 0x860, 0x8ff, 0xfb50, 0xfdcf, 0xfdf0, 0xfdff, 0xfe70, 0xfefe, 0x10d00, 0x10d3f, 0x10ec0, 0x10eff, 0x10f30, 0x10f6f, 0x1ec70, 0x1ecbf, 0x1ed00, 0x1ed4f, 0x1ee00, 0x1eeff]
const R_BLOCKS = [0x590, 0x5ff, 0x7c0, 0x85f, 0xfb1d, 0xfb4f, 0x10800, 0x10cff, 0x10d40, 0x10e5f, 0x10e80, 0x10ebf, 0x10f00, 0x10f2f, 0x10f70, 0x10fff, 0x1e800, 0x1ec6f, 0x1ecc0, 0x1ecff, 0x1ed50, 0x1edff, 0x1ef00, 0x1efff]

const MARK = /^[\p{Mn}\p{Me}]$/u
const FORMAT = /^\p{Cf}$/u
const CURRENCY = /^\p{Sc}$/u
const SPACE = /^\p{Zs}$/u
const STRONG_L = /^[\p{L}\p{Mc}\p{Nd}\p{Nl}\p{Co}\p{Cn}]$/u

function classCode(cp: number): number {
  if (cp < 0x80) return ASCII[cp]!
  switch (cp) {
    case 0x200e: return L // LRM
    case 0x200f: return R // RLM
    case 0x061c: return AL // ALM
    case 0x070f: return AL // SYRIAC ABBREVIATION MARK: a format character, but AL
    case 0x202a: return LRE
    case 0x202b: return RLE
    case 0x202c: return PDF
    case 0x202d: return LRO
    case 0x202e: return RLO
    case 0x2066: return LRI
    case 0x2067: return RLI
    case 0x2068: return FSI
    case 0x2069: return PDI
  }
  if (inRanges(cp, BN_RANGES)) return BN
  if (inRanges(cp, B_RANGES)) return B
  if (inRanges(cp, WS_RANGES)) return WS
  if (inRanges(cp, EN_RANGES)) return EN
  if (inRanges(cp, AN_RANGES)) return AN
  if (inRanges(cp, ES_RANGES)) return ES
  if (inRanges(cp, ET_RANGES)) return ET
  if (inRanges(cp, CS_RANGES)) return CS
  const ch = String.fromCodePoint(cp)
  if (MARK.test(ch)) return NSM
  if (FORMAT.test(ch)) return BN
  if (inRanges(cp, RTL_BLOCK_ON)) return ON
  if (inRanges(cp, AL_BLOCKS)) return AL
  if (inRanges(cp, R_BLOCKS)) return R
  if (CURRENCY.test(ch)) return ET
  if (STRONG_L.test(ch)) return L
  if (SPACE.test(ch)) return WS
  return ON
}

/** The Bidi_Class of a code point. */
export function bidiClassOf(cp: number): BidiClass {
  return NAMES[classCode(cp)]!
}

const isIsolateInitiator = (t: number) => t === LRI || t === RLI || t === FSI
const isRemovedByX9 = (t: number) => t === BN || (t >= LRE && t <= PDF)
// "NI" in UAX #9: neutrals and isolate formatting characters.
const isNI = (t: number) => t === B || t === S || t === WS || t === ON || t === LRI || t === RLI || t === FSI || t === PDI

/** Classes of every UTF-16 code unit (a surrogate pair shares its code point's class). */
function classesOf(text: string): number[] {
  const out: number[] = []
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!
    const t = classCode(cp)
    out.push(t)
    if (cp > 0xffff) {
      out.push(t)
      i++
    }
  }
  return out
}

/** BD9: for every isolate initiator, the index of its matching PDI (or -1). */
function matchingPdi(types: readonly number[]): number[] {
  const match = new Array<number>(types.length).fill(-1)
  const open: number[] = []
  for (let i = 0; i < types.length; i++) {
    const t = types[i]!
    if (isIsolateInitiator(t)) open.push(i)
    else if (t === PDI && open.length) match[open.pop()!] = i
    else if (t === B) open.length = 0
  }
  return match
}

/** P2-P3 on [from, to): 0 (LTR), 1 (RTL), or null without a strong character outside isolates. */
function firstStrongLevel(types: readonly number[], from: number, to: number, match: readonly number[]): 0 | 1 | null {
  for (let i = from; i < to; i++) {
    const t = types[i]!
    if (t === L) return 0
    if (t === R || t === AL) return 1
    if (isIsolateInitiator(t)) {
      if (match[i]! < 0) return null
      i = match[i]!
    } else if (t === B) return null
  }
  return null
}

/**
 * Paragraph direction the way the browser's `dir="auto"` decides it (P2-P3):
 * the first strong character outside isolates, or null when there is none.
 */
export function paragraphDirection(text: string): 'ltr' | 'rtl' | null {
  const types = classesOf(text)
  const level = firstStrongLevel(types, 0, types.length, matchingPdi(types))
  return level === null ? null : level === 1 ? 'rtl' : 'ltr'
}

const MAX_DEPTH = 125

// Bidi_Paired_Bracket pairs (opening -> closing). U+2329/U+232A are canonically U+3008/U+3009.
const BRACKETS = new Map<number, number>()
for (const [o, c] of [
  [0x28, 0x29], [0x5b, 0x5d], [0x7b, 0x7d], [0xf3a, 0xf3b], [0xf3c, 0xf3d], [0x169b, 0x169c], [0x2045, 0x2046], [0x207d, 0x207e], [0x208d, 0x208e],
  [0x2308, 0x2309], [0x230a, 0x230b], [0x3008, 0x3009], [0x2768, 0x2769], [0x276a, 0x276b], [0x276c, 0x276d], [0x276e, 0x276f], [0x2770, 0x2771],
  [0x2772, 0x2773], [0x2774, 0x2775], [0x27c5, 0x27c6], [0x27e6, 0x27e7], [0x27e8, 0x27e9], [0x27ea, 0x27eb], [0x27ec, 0x27ed], [0x27ee, 0x27ef],
  [0x2983, 0x2984], [0x2985, 0x2986], [0x2987, 0x2988], [0x2989, 0x298a], [0x298b, 0x298c], [0x298d, 0x2990], [0x298f, 0x298e], [0x2991, 0x2992],
  [0x2993, 0x2994], [0x2995, 0x2996], [0x2997, 0x2998], [0x29d8, 0x29d9], [0x29da, 0x29db], [0x29fc, 0x29fd], [0x2e22, 0x2e23], [0x2e24, 0x2e25],
  [0x2e26, 0x2e27], [0x2e28, 0x2e29], [0x300a, 0x300b], [0x300c, 0x300d], [0x300e, 0x300f], [0x3010, 0x3011], [0x3014, 0x3015], [0x3016, 0x3017],
  [0x3018, 0x3019], [0x301a, 0x301b], [0xfe59, 0xfe5a], [0xfe5b, 0xfe5c], [0xfe5d, 0xfe5e], [0xff08, 0xff09], [0xff3b, 0xff3d], [0xff5b, 0xff5d],
  [0xff5f, 0xff60], [0xff62, 0xff63],
] as const) BRACKETS.set(o, c)
const CLOSING = new Set<number>(BRACKETS.values())
const canonicalBracket = (cp: number) => (cp === 0x2329 ? 0x3008 : cp === 0x232a ? 0x3009 : cp)

export interface ParagraphLevels {
  /** Resolved embedding level of every UTF-16 code unit (before the per-line rule L1). */
  levels: number[]
  /** Paragraph embedding level: 0 left-to-right, 1 right-to-left. */
  paragraphLevel: 0 | 1
  /** Original Bidi_Class code of every code unit (for L1). */
  types: number[]
}

/**
 * Resolve the embedding levels of one paragraph (UAX #9 up to I2).
 * `direction` is the paragraph direction; 'auto' applies P2-P3 and falls back
 * to `fallback` when the paragraph has no strong character.
 */
export function resolveParagraph(text: string, direction: 'ltr' | 'rtl' | 'auto' = 'auto', fallback: 'ltr' | 'rtl' = 'ltr'): ParagraphLevels {
  const original = classesOf(text)
  const n = original.length
  const match = matchingPdi(original)
  const auto = firstStrongLevel(original, 0, n, match)
  const paragraphLevel: 0 | 1 = direction === 'rtl' ? 1 : direction === 'ltr' ? 0 : auto ?? (fallback === 'rtl' ? 1 : 0)
  const types = original.slice()
  const levels = new Array<number>(n).fill(paragraphLevel)

  // X1-X8: explicit levels and directions.
  type Entry = { level: number; override: number; isolate: boolean }
  const stack: Entry[] = [{ level: paragraphLevel, override: ON, isolate: false }]
  const top = () => stack[stack.length - 1]!
  let overflowIsolates = 0
  let overflowEmbeddings = 0
  let validIsolates = 0
  for (let i = 0; i < n; i++) {
    const t = original[i]!
    const current = top()
    if (t === RLE || t === LRE || t === RLO || t === LRO) {
      const level = t === RLE || t === RLO ? (current.level + 1) | 1 : (current.level + 2) & ~1
      if (level <= MAX_DEPTH && overflowIsolates === 0 && overflowEmbeddings === 0) {
        stack.push({ level, override: t === RLO ? R : t === LRO ? L : ON, isolate: false })
      } else if (overflowIsolates === 0) overflowEmbeddings++
      levels[i] = current.level
    } else if (isIsolateInitiator(t)) {
      levels[i] = current.level
      if (current.override !== ON) types[i] = current.override
      const rtl = t === RLI || (t === FSI && firstStrongLevel(original, i + 1, match[i]! < 0 ? n : match[i]!, match) === 1)
      const level = rtl ? (current.level + 1) | 1 : (current.level + 2) & ~1
      if (level <= MAX_DEPTH && overflowIsolates === 0 && overflowEmbeddings === 0) {
        validIsolates++
        stack.push({ level, override: ON, isolate: true })
      } else overflowIsolates++
    } else if (t === PDI) {
      if (overflowIsolates > 0) overflowIsolates--
      else if (validIsolates > 0) {
        overflowEmbeddings = 0
        while (!top().isolate) stack.pop()
        stack.pop()
        validIsolates--
      }
      levels[i] = top().level
      if (top().override !== ON) types[i] = top().override
    } else if (t === PDF) {
      if (overflowIsolates > 0) {
        // nothing
      } else if (overflowEmbeddings > 0) overflowEmbeddings--
      else if (!current.isolate && stack.length >= 2) stack.pop()
      levels[i] = current.level
    } else if (t === B) {
      levels[i] = paragraphLevel
    } else {
      levels[i] = current.level
      if (t !== BN && current.override !== ON) types[i] = current.override
    }
  }

  // X9 / X10: level runs of the characters that remain, chained into isolating run sequences.
  const explicit = levels.slice()
  const isMatchedPdi = new Array<boolean>(n).fill(false)
  for (let i = 0; i < n; i++) if (match[i]! >= 0) isMatchedPdi[match[i]!] = true
  const kept: number[] = []
  for (let i = 0; i < n; i++) if (!isRemovedByX9(original[i]!)) kept.push(i)
  const runs: number[][] = []
  for (const i of kept) {
    const run = runs[runs.length - 1]
    if (run && explicit[run[run.length - 1]!] === explicit[i]) run.push(i)
    else runs.push([i])
  }
  const runStartingAt = new Map<number, number[]>()
  for (const run of runs) runStartingAt.set(run[0]!, run)
  const keptIndex = new Array<number>(n).fill(-1)
  kept.forEach((i, k) => (keptIndex[i] = k))
  for (const run of runs) {
    // A run that starts with a matched PDI continues its initiator's sequence.
    if (isMatchedPdi[run[0]!]) continue
    const seq = [...run]
    let last = seq[seq.length - 1]!
    while (isIsolateInitiator(original[last]!) && match[last]! >= 0) {
      const next = runStartingAt.get(match[last]!)
      if (!next) break
      seq.push(...next)
      last = seq[seq.length - 1]!
    }
    resolveSequence(seq, types, original, explicit, levels, text, kept, keptIndex, paragraphLevel)
  }

  // Characters removed by X9 take the level of the preceding character (or the paragraph's).
  for (let i = 0; i < n; i++) if (isRemovedByX9(original[i]!)) levels[i] = i > 0 ? levels[i - 1]! : paragraphLevel
  return { levels, paragraphLevel, types: original }
}

function resolveSequence(seq: number[], types: number[], original: number[], explicit: number[], levels: number[], text: string, kept: number[], keptIndex: number[], paragraphLevel: number) {
  // sos/eos compare explicit embedding levels (X10), never levels already resolved by I1/I2.
  const first = seq[0]!
  const last = seq[seq.length - 1]!
  const level = explicit[first]!
  const before = keptIndex[first]! > 0 ? explicit[kept[keptIndex[first]! - 1]!]! : paragraphLevel
  const afterK = keptIndex[last]! + 1
  const after = isIsolateInitiator(original[last]!) || afterK >= kept.length ? paragraphLevel : explicit[kept[afterK]!]!
  const sos = Math.max(before, level) % 2 ? R : L
  const eos = Math.max(after, level) % 2 ? R : L
  const m = seq.length
  const t = seq.map((i) => types[i]!)
  const at = (k: number) => t[k]!

  // W1: NSM takes the type of the previous character (ON after an isolate initiator or PDI).
  for (let k = 0; k < m; k++) {
    if (at(k) !== NSM) continue
    if (k === 0) t[k] = sos
    else t[k] = isIsolateInitiator(at(k - 1)) || at(k - 1) === PDI ? ON : at(k - 1)
  }
  // W2: EN after AL becomes AN.
  let lastStrong = sos
  for (let k = 0; k < m; k++) {
    if (at(k) === L || at(k) === R || at(k) === AL) lastStrong = at(k)
    else if (at(k) === EN && lastStrong === AL) t[k] = AN
  }
  // W3: AL becomes R.
  for (let k = 0; k < m; k++) if (at(k) === AL) t[k] = R
  // W4: a single separator between two numbers of the same kind joins them.
  for (let k = 1; k < m - 1; k++) {
    if ((at(k) === ES || at(k) === CS) && at(k - 1) === EN && at(k + 1) === EN) t[k] = EN
    else if (at(k) === CS && at(k - 1) === AN && at(k + 1) === AN) t[k] = AN
  }
  // W5: terminators next to European numbers become EN.
  for (let k = 0; k < m; k++) {
    if (at(k) !== ET) continue
    let end = k
    while (end < m && at(end) === ET) end++
    if ((k > 0 && at(k - 1) === EN) || (end < m && at(end) === EN)) for (let j = k; j < end; j++) t[j] = EN
    k = end - 1
  }
  // W6: remaining separators and terminators become ON.
  for (let k = 0; k < m; k++) if (at(k) === ES || at(k) === ET || at(k) === CS) t[k] = ON
  // W7: EN after L (or sos L) becomes L.
  lastStrong = sos
  for (let k = 0; k < m; k++) {
    if (at(k) === L || at(k) === R) lastStrong = at(k)
    else if (at(k) === EN && lastStrong === L) t[k] = L
  }

  // N0: paired brackets take the direction of what they enclose (or of their context).
  const embedding = level % 2 ? R : L
  const strongOf = (x: number) => (x === L ? L : x === R || x === EN || x === AN ? R : -1)
  const pairs: Array<[number, number]> = []
  const openStack: Array<[number, number]> = [] // [closing code point, sequence position]
  for (let k = 0; k < m; k++) {
    if (at(k) !== ON) continue
    const cp = canonicalBracket(text.codePointAt(seq[k]!)!)
    const closing = BRACKETS.get(cp)
    if (closing !== undefined) {
      if (openStack.length === 63) {
        pairs.length = 0 // BD16: overflow stops pairing for this sequence
        break
      }
      openStack.push([canonicalBracket(closing), k])
    } else if (CLOSING.has(cp)) {
      for (let s = openStack.length - 1; s >= 0; s--) {
        if (openStack[s]![0] === cp) {
          pairs.push([openStack[s]![1], k])
          openStack.length = s
          break
        }
      }
    }
  }
  pairs.sort((a, b) => a[0] - b[0])
  for (const [open, close] of pairs) {
    let foundEmbedding = false
    let foundOpposite = false
    for (let k = open + 1; k < close; k++) {
      const s = strongOf(at(k))
      if (s === embedding) foundEmbedding = true
      else if (s !== -1) foundOpposite = true
    }
    let resolved = -1
    if (foundEmbedding) resolved = embedding
    else if (foundOpposite) {
      let context = sos
      for (let k = open - 1; k >= 0; k--) {
        const s = strongOf(at(k))
        if (s !== -1) {
          context = s
          break
        }
      }
      resolved = context !== embedding ? context : embedding
    }
    if (resolved === -1) continue
    t[open] = resolved
    t[close] = resolved
    for (const bracket of [open, close]) for (let k = bracket + 1; k < m && original[seq[k]!] === NSM; k++) t[k] = resolved
  }

  // N1 / N2: neutrals between two strong runs of the same direction take it; others the embedding direction.
  for (let k = 0; k < m; k++) {
    if (!isNI(at(k))) continue
    let end = k
    while (end < m && isNI(at(end))) end++
    const prev = k === 0 ? sos : strongOf(at(k - 1)) === -1 ? embedding : strongOf(at(k - 1))
    const next = end === m ? eos : strongOf(at(end)) === -1 ? embedding : strongOf(at(end))
    const resolved = prev === next ? prev : embedding
    for (let j = k; j < end; j++) t[j] = resolved
    k = end - 1
  }

  // I1 / I2: implicit levels.
  for (let k = 0; k < m; k++) {
    const x = at(k)
    levels[seq[k]!] = level % 2 === 0 ? (x === R ? level + 1 : x === AN || x === EN ? level + 2 : level) : x === L || x === EN || x === AN ? level + 1 : level
  }
}

/**
 * Rule L1 for one line [from, to) of a resolved paragraph: segment and
 * paragraph separators, and whitespace (and isolate controls) before them or
 * at the end of the line, return to the paragraph level. Returns a copy.
 */
export function lineLevels(p: ParagraphLevels, from: number, to: number): number[] {
  const out = p.levels.slice(from, to)
  const resettable = (t: number) => t === WS || isIsolateInitiator(t) || t === PDI || isRemovedByX9(t)
  let trailing = true
  for (let i = to - 1; i >= from; i--) {
    const t = p.types[i]!
    if (t === S || t === B) {
      out[i - from] = p.paragraphLevel
      trailing = true
    } else if (trailing && resettable(t)) out[i - from] = p.paragraphLevel
    else trailing = false
  }
  return out
}

/**
 * Rule L2: the visual order (left to right) of items with the given levels,
 * as indices into `levels`. From the highest level down to the lowest odd
 * level, every maximal run at that level or higher is reversed.
 */
export function visualOrder(levels: readonly number[]): number[] {
  const order = levels.map((_, i) => i)
  if (levels.length === 0) return order
  const max = Math.max(...levels)
  const min = Math.min(...levels)
  const lowestOdd = min % 2 ? min : min + 1
  for (let level = max; level >= lowestOdd; level--) {
    for (let i = 0; i < order.length; i++) {
      if (levels[order[i]!]! < level) continue
      let end = i
      while (end < order.length && levels[order[end]!]! >= level) end++
      order.splice(i, end - i, ...order.slice(i, end).reverse())
      i = end
    }
  }
  return order
}

/** For tests and diagnostics: the code points of one line of text in visual order (left to right). */
export function visualString(text: string, direction: 'ltr' | 'rtl' | 'auto' = 'auto', fallback: 'ltr' | 'rtl' = 'ltr'): string {
  const p = resolveParagraph(text, direction, fallback)
  const line = lineLevels(p, 0, text.length)
  const units = Array.from(text)
  const levels: number[] = []
  let i = 0
  for (const u of units) {
    levels.push(line[i]!)
    i += u.length
  }
  return visualOrder(levels).map((k) => units[k]!).join('')
}
