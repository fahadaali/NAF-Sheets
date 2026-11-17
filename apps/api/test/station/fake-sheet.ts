// An in-memory Google spreadsheet behind the station's SheetPort: values,
// row identities that move with their rows, cell writes, inserted rows, notes.

import { GoogleError } from '../../src/station/google'
import type { SheetPort } from '../../src/station/run'

type Cell = string | number | boolean | null

interface FakeTab {
  sheetId: number
  title: string
  rows: Cell[][]
  ids: (string | null)[]
}

const SERIAL_EPOCH = Date.UTC(1899, 11, 30)

/**
 * What Google stores for a value written with USER_ENTERED, as far as the
 * station meets it: a leading apostrophe keeps text as text (and is dropped);
 * otherwise a typed date becomes a serial number, a number or percentage a
 * number, and a formula an error value.
 */
function userEntered(value: string | number | null): Cell {
  if (typeof value !== 'string') return value
  if (value.startsWith("'")) return value.slice(1)
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return Math.round((Date.parse(value) - SERIAL_EPOCH) / 86_400_000)
  if (/^[+-]?\d+(\.\d+)?%$/.test(value)) return Number(value.slice(0, -1)) / 100
  if (/^[+-]?\d+(\.\d+)?$/.test(value)) return Number(value)
  if (value.startsWith('=')) return '#ERROR!'
  return value
}

export class FakeSheet implements SheetPort {
  readonly serviceAccountEmail = 'naf-sync@naf-sheets-station.iam.gserviceaccount.com'
  readonly tabs: FakeTab[] = []
  readonly notes = new Map<string, string>()
  title = 'الاتصال المؤسسي والتسويق'
  shared = true
  version = 0
  writes = 0

  addTab(sheetId: number, title: string, rows: Cell[][]): FakeTab {
    const tab = { sheetId, title, rows: rows.map((r) => [...r]), ids: rows.map(() => null) }
    this.tabs.push(tab)
    return tab
  }

  tab(title: string): FakeTab {
    const t = this.tabs.find((x) => x.title === title)
    if (!t) throw new Error(`no tab ${title}`)
    return t
  }

  /** A person edits a cell. */
  set(title: string, row: number, column: number, value: Cell): void {
    const t = this.tab(title)
    while (t.rows.length <= row) {
      t.rows.push([])
      t.ids.push(null)
    }
    t.rows[row]![column] = value
    this.version += 1
  }

  /** A person deletes rows (the identities go with them). */
  deleteRows(title: string, row: number, count = 1): void {
    const t = this.tab(title)
    t.rows.splice(row, count)
    t.ids.splice(row, count)
    this.version += 1
  }

  private check(): void {
    if (!this.shared) throw new GoogleError('file_not_accessible', 403)
  }

  async modifiedTime(): Promise<string> {
    this.check()
    return new Date(Date.UTC(2026, 10, 15) + this.version * 1000).toISOString()
  }

  async spreadsheet(): Promise<{ title: string; tabs: { sheetId: number; title: string }[] }> {
    this.check()
    return { title: this.title, tabs: this.tabs.map((t) => ({ sheetId: t.sheetId, title: t.title })) }
  }

  async tabValues(_id: string, titles: readonly string[]): Promise<Map<string, unknown[][]>> {
    this.check()
    return new Map(titles.map((title) => [title, structuredClone(this.tab(title).rows) as unknown[][]]))
  }

  async rowIdentities(): Promise<{ sheetId: number; row: number; uid: string; metadataId: number }[]> {
    this.check()
    return this.tabs.flatMap((t) => t.ids.flatMap((uid, row) => (uid ? [{ sheetId: t.sheetId, row, uid, metadataId: row }] : [])))
  }

  async write(
    _id: string,
    changes: { identities?: { sheetId: number; row: number; uid: string }[]; cells?: { tabTitle: string; row: number; column: number; value: string | number | null }[] },
  ): Promise<void> {
    this.check()
    for (const i of changes.identities ?? []) this.tabs.find((t) => t.sheetId === i.sheetId)!.ids[i.row] = i.uid
    for (const c of changes.cells ?? []) {
      const t = this.tab(c.tabTitle)
      t.rows[c.row]![c.column] = userEntered(c.value)
    }
    if ((changes.identities?.length ?? 0) + (changes.cells?.length ?? 0) > 0) {
      this.writes += 1
      this.version += 1
    }
  }

  async insertRows(_id: string, inserts: { sheetId: number; before: number; values: (string | number | null)[]; uid: string }[]): Promise<void> {
    this.check()
    const ordered = inserts.map((ins, i) => ({ ins, i })).sort((a, b) => b.ins.before - a.ins.before || b.i - a.i)
    for (const { ins } of ordered) {
      const t = this.tabs.find((x) => x.sheetId === ins.sheetId)!
      t.rows.splice(ins.before, 0, [...ins.values])
      t.ids.splice(ins.before, 0, ins.uid)
      // Notes move with their cells.
      const moved = [...this.notes].map(([key, note]) => {
        const [sheet, row, column] = key.split(':').map(Number) as [number, number, number]
        return [sheet === t.sheetId && row >= ins.before ? `${sheet}:${row + 1}:${column}` : key, note] as const
      })
      this.notes.clear()
      for (const [key, note] of moved) this.notes.set(key, note)
    }
    if (inserts.length > 0) this.version += 1
  }

  async setNotes(_id: string, notes: { sheetId: number; row: number; column: number; note: string | null }[]): Promise<void> {
    this.check()
    for (const n of notes) {
      const key = `${n.sheetId}:${n.row}:${n.column}`
      if (n.note) this.notes.set(key, n.note)
      else this.notes.delete(key)
    }
    // A note is an edit of the file: Drive's modifiedTime moves, a notification goes out.
    if (notes.length > 0) this.version += 1
  }
}
