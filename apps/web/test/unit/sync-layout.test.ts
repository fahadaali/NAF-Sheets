// The layout of a synced sheet comes from the mapping committed in the wizard
// (`SheetMeta.columns`, apps/web/OPEN_QUESTIONS.md #33); header inference is
// only the fallback for a payload without one.

import { describe, expect, it } from 'vitest'
import { snapshotReader } from '../../src/sync/cells'
import { sheetLayout } from '../../src/sync/layout'
import { META, SHEET, syncedWorkbook } from './sync-fixtures'

describe('sheetLayout', () => {
  it('uses the stored mapping where the header texts would say otherwise', () => {
    const reader = snapshotReader(syncedWorkbook([{ title: 'أولى' }]).sheets[SHEET] as never)
    // Column D's header reads «تاريخ الاستحقاق», but the wizard mapped it to the start date.
    const stored = sheetLayout(reader, {
      ...META,
      columns: [
        { columnKey: 'A', field: 'title' },
        { columnKey: 'D', field: 'starts_on' },
        { columnKey: 'E', field: 'completed' },
      ],
      completedValues: ['منجز'],
    })
    expect(stored?.fields).toEqual({ title: 0, starts_on: 3, completed: 4 })
    expect(stored?.plan?.completedValues).toEqual(['منجز'])
    expect(stored?.plan?.columns.map((c) => c.columnKey)).toEqual(['A', 'D', 'E'])
    expect(stored?.system).not.toBeNull()

    const inferred = sheetLayout(reader, META)
    expect(inferred?.fields.due_on).toBe(3)
    expect(inferred?.fields.starts_on).toBe(2)
  })

  it('falls back to the header texts when no mapping is stored', () => {
    const reader = snapshotReader(syncedWorkbook([{ title: 'أولى' }]).sheets[SHEET] as never)
    const layout = sheetLayout(reader, { ...META, columns: [] })
    expect(layout?.fields.title).toBe(0)
    expect(layout?.fields.due_on).toBe(3)
  })
})
