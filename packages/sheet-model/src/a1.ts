// Column letters (`ColumnPlan.columnKey`, e.g. "A", "AB") and 0-based indexes.

/** "A" → 0, "Z" → 25, "AA" → 26. `null` for anything that is not 1–3 Latin letters. */
export function columnIndex(key: string): number | null {
  const k = key.trim().toUpperCase()
  if (!/^[A-Z]{1,3}$/.test(k)) return null
  let n = 0
  for (const ch of k) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/** 0 → "A", 26 → "AA". */
export function columnLetters(index: number): string {
  let n = index + 1
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}
