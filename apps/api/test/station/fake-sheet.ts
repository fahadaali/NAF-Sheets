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
      // USER_ENTERED: a typed date becomes a serial number.
      const v = typeof c.value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.value) ? Math.round((Date.parse(c.value) - SERIAL_EPOCH) / 86_400_000) : c.value
      const t = this.tab(c.tabTitle)
      t.rows[c.row]![c.column] = v
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
  }
}
