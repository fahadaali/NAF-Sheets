// Pictures of an imported .xlsx (owner 2026-11-11): stored in R2 under the new
// workbook, written into the snapshot as URLs, served to its members, counted
// in the report, and kept by the room (headless Univer with the drawing
// plugins) when it saves the workbook again.

import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { ImportXlsxResponse } from '@naf-sheets/shared'
import { parseImagePath } from '@naf-sheets/shared'
import { cellImages } from '@naf-sheets/sheet-model'
import { excelPicturesFixture } from '../../../../packages/xlsx-import/test/fixtures/excel-pictures'
import { loadHeadlessWorkbook } from '../../src/room/engine'
import { registerGoogleImportRoutes } from '../../src/google-import'
import { registerXlsxImportRoutes } from '../../src/xlsx-import'
import { call, json, seedMember, TEST_USER_HEADER, testApp } from '../helpers'

vi.setConfig({ testTimeout: 60_000 })
beforeAll(async () => {
  await import('../../src/room/engine')
}, 120_000)

const app = testApp()
registerGoogleImportRoutes(app)
registerXlsxImportRoutes(app)

type Snap = { id: string; sheets: Record<string, { cellData?: Record<string, Record<string, unknown>> }>; resources?: Array<{ name: string; data: string }> }

function drawings(snapshot: Snap): Array<Record<string, unknown>> {
  const res = snapshot.resources?.find((r) => r.name === 'SHEET_DRAWING_PLUGIN')
  if (!res) return []
  return Object.values(JSON.parse(res.data) as Record<string, { data: Record<string, Record<string, unknown>> }>).flatMap((s) => Object.values(s.data))
}

describe('importing an .xlsx with pictures', () => {
  it('stores each picture once in R2, writes URLs (never bytes), serves them to members only', async () => {
    const owner = await seedMember('editor')
    const outsider = await seedMember('editor')
    const bytes = await excelPicturesFixture()
    const res = await app.request(
      '/api/import/xlsx?name=' + encodeURIComponent('الصور.xlsx'),
      { method: 'POST', headers: { [TEST_USER_HEADER]: owner.id, 'content-length': String(bytes.byteLength), 'content-type': 'application/octet-stream' }, body: bytes },
      env,
    )
    expect(res.status).toBe(201)
    const { workbookId } = await json<ImportXlsxResponse>(res)

    const objects = (await env.ATTACHMENTS.list({ prefix: `workbooks/${workbookId}/images/`, include: ['customMetadata'] } as R2ListOptions)).objects
    expect(objects).toHaveLength(2)
    expect(objects.every((o) => o.customMetadata?.origin === 'import' && o.customMetadata?.uploadedBy === owner.id)).toBe(true)

    const wb = await json<{ snapshot: Snap }>(await call(app, 'GET', `/api/workbooks/${workbookId}`, { user: owner }))
    const floating = drawings(wb.snapshot)
    expect(floating).toHaveLength(4)
    for (const d of floating) expect(parseImagePath(d.source)).toMatchObject({ workbookId })
    expect(JSON.stringify(wb.snapshot)).not.toContain('base64')
    const sheet = Object.values(wb.snapshot.sheets).find((s) => s.cellData?.[2]?.[1])!
    const inCell = cellImages(sheet.cellData![2]![1] as never)
    expect(inCell).toHaveLength(1)

    const url = floating[0]!.source as string
    expect((await call(app, 'GET', url, { user: owner })).status).toBe(200)
    expect((await call(app, 'GET', url, { user: outsider })).status).toBe(404)

    const report = await json<{ report: { counts: Record<string, number>; items: Array<{ kind: string; outcome: string }> } }>(await call(app, 'GET', `/api/workbooks/${workbookId}/import-report`, { user: owner }))
    expect(report.report.counts).toMatchObject({ floatingImages: 4, cellImages: 1 })
    expect(report.report.items.filter((i) => i.kind === 'drawing_image' && i.outcome === 'not_transferred')).toHaveLength(2)

    const { results } = await env.DB.prepare(`SELECT details_json FROM audit_log WHERE workbook_id = ?1 AND action = 'workbook.import.xlsx'`).bind(workbookId).all<{ details_json: string }>()
    expect(JSON.parse(results[0]!.details_json).pictures).toEqual({ floating: 4, inCell: 1, skipped: 4 })

    // The room's headless Univer keeps every picture through a load and a save.
    const headless = loadHeadlessWorkbook(wb.snapshot as unknown as Record<string, unknown>)
    try {
      const saved = headless.snapshot() as unknown as Snap
      expect(drawings(saved).map((d) => d.source).sort()).toEqual(floating.map((d) => d.source).sort())
      const savedSheet = Object.values(saved.sheets).find((s) => s.cellData?.[2]?.[1])!
      expect(cellImages(savedSheet.cellData![2]![1] as never)).toHaveLength(1)
    } finally {
      headless.dispose()
    }
  })
})
