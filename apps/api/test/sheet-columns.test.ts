// GET /api/workbooks/:id carries each sheet's stored column mapping
// (`SheetMeta.columns`, `completedValues`; apps/web/OPEN_QUESTIONS.md #33).

import { describe, expect, it } from 'vitest'
import { call, createWorkbook, json, seedMember, testApp } from './helpers'
import { harness, setupLinked } from './sync/harness'
import type { SheetMeta } from '@naf-sheets/shared'

describe('SheetMeta column mapping', () => {
  it('a linked sheet carries the mapping committed by the wizard, in column order, with its completed values', async () => {
    const h = harness()
    const l = await setupLinked(h, {
      rows: [{ title: 'أولى' }],
      plan: {
        columns: [
          { columnKey: 'A', field: 'title' },
          { columnKey: 'B', field: 'assignees' },
          { columnKey: 'D', field: 'due_on' },
          { columnKey: 'E', field: 'completed' },
          { columnKey: 'G', field: 'free', appendToDescription: true },
        ],
        completedValues: ['منجز', 'تم'],
      },
    })
    const res = await call(h.app, 'GET', `/api/workbooks/${l.wbId}`, { user: l.owner, env: h.env })
    const sheets = (await json<{ sheets: SheetMeta[] }>(res)).sheets
    expect(sheets[0]?.columns).toEqual([
      { columnKey: 'A', field: 'title' },
      { columnKey: 'B', field: 'assignees' },
      { columnKey: 'D', field: 'due_on' },
      { columnKey: 'E', field: 'completed' },
      { columnKey: 'G', field: 'free', appendToDescription: true },
    ])
    expect(sheets[0]?.completedValues).toEqual(['منجز', 'تم'])
  })

  it('a sheet never linked has an empty mapping', async () => {
    const app = testApp()
    const owner = await seedMember('editor')
    const id = await createWorkbook(app, owner)
    const res = await call(app, 'GET', `/api/workbooks/${id}`, { user: owner })
    const sheets = (await json<{ sheets: SheetMeta[] }>(res)).sheets
    expect(sheets[0]).toMatchObject({ columns: [], completedValues: [] })
  })
})
