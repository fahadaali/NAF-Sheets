// Images inside a cell (src/cell-images.ts): never text, never cleared by an
// inbound write, and a field whose cell holds only a picture follows Basecamp
// (owner 2026-11-11; apps/api OPEN_QUESTIONS.md "Images").

import type { ICellData } from '@univerjs/core'
import { describe, expect, it } from 'vitest'
import { applyInbound, cellImages, cellText, imageOnlyFields, readTasks, type WorkbookSnapshot } from '../src'
import { cell, defaultPlan, linkedWorkbook, putRow } from './helpers'

const S = 'sheet-1'
const SRC = '/api/workbooks/wb-1/images/' + 'a'.repeat(32)

/** The cell Univer 1.4.0's InsertCellImageCommand writes (captured from @univerjs/core BuildTextUtils.drawing.add). */
function univerImageCell(source = SRC, id = 'img1'): ICellData {
  return {
    t: 1,
    p: {
      id: 'd',
      drawings: {
        [id]: {
          unitId: 'd', subUnitId: 'd', drawingId: id, drawingType: 0, imageSourceType: 'URL', source,
          transform: { left: 0, top: 0, width: 50, height: 40 },
          docTransform: { size: { width: 50, height: 40 }, positionH: { relativeFrom: 0, posOffset: 0 }, positionV: { relativeFrom: 0, posOffset: 0 }, angle: 0 },
          behindDoc: 0, title: '', description: '', layoutType: 0, wrapText: 0, distB: 0, distL: 0, distR: 0, distT: 0,
        },
      },
      drawingsOrder: [id],
      body: {
        dataStream: '\r\b\r\n',
        textRuns: [],
        paragraphs: [{ startIndex: 0 }, { startIndex: 2 }],
        sectionBreaks: [{ startIndex: 3 }],
        customBlocks: [{ startIndex: 1, blockId: id }],
      },
      documentStyle: {},
    },
  } as unknown as ICellData
}

/** A picture followed by text in the same cell. */
function imageAndText(text: string): ICellData {
  const c = univerImageCell()
  ;(c.p as { body: { dataStream: string } }).body.dataStream = `\r\b\r${text}\r\n`
  return c
}

function read(workbook: WorkbookSnapshot, bcId: number | null = 500) {
  const r = readTasks(workbook, S, defaultPlan(S), { rowState: () => ({ bcId, assignees: [{ kind: 'bc_person', bcPersonId: 11, source: 'manual' }] }) })
  if (!r.ok) throw new Error(r.error.message)
  return r.value
}

describe('cell images: reading', () => {
  it('finds the picture of a Univer image cell, and reads no text from it', () => {
    const c = univerImageCell()
    expect(cellImages(c)).toEqual([{ drawingId: 'img1', source: SRC, imageSourceType: 'URL', width: 50, height: 40 }])
    expect(cellText(c)).toBe('')
    expect(cellText(imageAndText('ملاحظة'))).toBe('ملاحظة')
    expect(cellImages({ v: 'نص' })).toEqual([])
  })

  it('a picture-only title, assignee, date, status or notes cell is no issue and is marked image-only', () => {
    const { workbook } = linkedWorkbook(['إعداد الخطة'])
    putRow(workbook, S, 1, { A: univerImageCell(), B: univerImageCell(), C: univerImageCell(), D: univerImageCell(), E: univerImageCell(), G: univerImageCell() })
    const { tasks, issues } = read(workbook)
    expect(issues).toEqual([])
    const task = tasks[0]!
    expect(imageOnlyFields(task)).toEqual(['title', 'assignees', 'due_on', 'starts_on', 'completed', 'notes'])
    // The stored assignees stay; the other fields are restored from Basecamp's base by the API (diffLocal).
    expect(task.assignees).toEqual([{ kind: 'bc_person', bcPersonId: 11, source: 'manual' }])
    expect(task.dueOn).toBeNull()
  })

  it('a picture beside text reads the text only, and is not image-only', () => {
    const { workbook } = linkedWorkbook(['x'])
    putRow(workbook, S, 1, { A: imageAndText('إعداد الخطة'), G: imageAndText('سطر') })
    const { tasks, issues } = read(workbook)
    expect(issues).toEqual([])
    expect(tasks[0]!.title).toBe('إعداد الخطة')
    expect(tasks[0]!.notesHtml).toBe('<div>سطر</div>')
    expect(imageOnlyFields(tasks[0]!)).toEqual([])
  })

  it('a row not in Basecamp yet still needs a text title', () => {
    const { workbook } = linkedWorkbook(['إعداد الخطة'])
    putRow(workbook, S, 1, { A: univerImageCell() })
    expect(read(workbook, null).issues.map((i) => i.code)).toEqual(['empty_title'])
  })
})

describe('cell images: inbound writes never remove a picture', () => {
  const update = (fields: Record<string, unknown>) => [{ type: 'update_row' as const, uid: 'u-1', fields }]

  it('a new title, date, status and notes from Basecamp keep the pictures of their cells', () => {
    const { workbook, plan } = linkedWorkbook(['إعداد الخطة'])
    putRow(workbook, S, 1, { A: univerImageCell(SRC, 'a'), D: univerImageCell(SRC, 'd'), E: univerImageCell(SRC, 'e'), G: univerImageCell(SRC, 'g') })
    const result = applyInbound(workbook, S, plan, update({ title: 'العنوان من Basecamp', dueOn: '2026-11-20', completed: true, notesHtml: '<div>وصف</div>' }), {
      deletedStyle: { st: { s: 1 } } as never,
    })
    if (!result.ok) throw new Error(result.error.message)
    const wb = result.value.workbook
    for (const [col, id] of [['A', 'a'], ['D', 'd'], ['E', 'e'], ['G', 'g']] as const) {
      expect(cellImages(cell(wb, S, 1, col)).map((i) => i.drawingId)).toEqual([id])
    }
    expect(cellText(cell(wb, S, 1, 'A'))).toBe('العنوان من Basecamp')
    expect(cellText(cell(wb, S, 1, 'D'))).toBe('2026-11-20')
    expect(cellText(cell(wb, S, 1, 'G'))).toBe('وصف')
    const back = read(wb).tasks[0]!
    expect(back).toMatchObject({ title: 'العنوان من Basecamp', dueOn: '2026-11-20', completed: true })
    expect(imageOnlyFields(back)).toEqual([])
  })

  it('clearing a field in Basecamp clears the text only; the same value twice is unchanged', () => {
    const { workbook, plan } = linkedWorkbook(['إعداد الخطة'])
    putRow(workbook, S, 1, { G: imageAndText('قديم') })
    const opts = { deletedStyle: { st: { s: 1 } } as never }
    const cleared = applyInbound(workbook, S, plan, update({ notesHtml: null }), opts)
    if (!cleared.ok) throw new Error(cleared.error.message)
    const g = cell(cleared.value.workbook, S, 1, 'G')
    expect(cellImages(g)).toHaveLength(1)
    expect(cellText(g)).toBe('')
    const again = applyInbound(cleared.value.workbook, S, plan, update({ notesHtml: null }), opts)
    if (!again.ok) throw new Error(again.error.message)
    expect(again.value.changedCells).toEqual([])
  })
})
