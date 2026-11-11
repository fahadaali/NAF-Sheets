// Pictures in the editor (src/images): what is refused before any upload, the
// upload's answers, and the dashboard refusing a picture.

import { describe, expect, it } from 'vitest'
import { IMAGE_MAX_BYTES } from '@naf-sheets/shared'
import { guardDashboardCommand } from '../../src/dashboard/sheet-guard'
import { checkImageFile, imageUploadPath, uploadImage } from '../../src/images/image-upload'
import { t } from '../../src/strings'

const file = (type: string, size = 10, name = 'صورة.png') => new File([new Uint8Array(size)], name, { type })

describe('checkImageFile', () => {
  it('accepts PNG, JPEG, GIF and WebP up to the limit; refuses SVG, BMP, empty and oversized files', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) expect(checkImageFile({ type, size: 100 })).toBeNull()
    expect(checkImageFile({ type: 'image/svg+xml', size: 100 })).toBe(t.images.typeNotAllowed)
    expect(checkImageFile({ type: 'image/bmp', size: 100 })).toBe(t.images.typeNotAllowed)
    expect(checkImageFile({ type: 'image/png', size: 0 })).toBe(t.images.typeNotAllowed)
    expect(checkImageFile({ type: 'image/png', size: IMAGE_MAX_BYTES + 1 })).toMatch(/10 ميغابايت/)
  })
})

describe('uploadImage', () => {
  it('posts the bytes to the workbook and answers the same-origin URL', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const id = 'c'.repeat(32)
    const result = await uploadImage('wb 1', file('image/png'), async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ imageId: id, url: 'ignored', contentType: 'image/png', size: 10 }), { status: 201 })
    })
    expect(result).toEqual({ ok: true, imageId: id, url: `/api/workbooks/wb%201/images/${id}` })
    expect(calls[0]!.url).toBe(imageUploadPath('wb 1', 'صورة.png'))
    expect(calls[0]!.init).toMatchObject({ method: 'POST', credentials: 'same-origin' })
  })

  it('shows the API’s Arabic message on a refusal, a fallback on a broken answer, and never sends a refused type', async () => {
    const refused = await uploadImage('wb', file('image/png'), async () => new Response(JSON.stringify({ ok: false, error: 'forbidden', message: 'لا تملك صلاحية' }), { status: 403 }))
    expect(refused).toEqual({ ok: false, message: 'لا تملك صلاحية' })
    const broken = await uploadImage('wb', file('image/png'), async () => new Response('<html>', { status: 502 }))
    expect(broken).toEqual({ ok: false, message: t.images.uploadFailed })
    const offline = await uploadImage('wb', file('image/png'), async () => {
      throw new TypeError('network')
    })
    expect(offline).toEqual({ ok: false, message: t.errors.network })
    let called = false
    const svg = await uploadImage('wb', file('image/svg+xml', 10, 'x.svg'), async () => {
      called = true
      return new Response(null, { status: 201 })
    })
    expect(svg).toEqual({ ok: false, message: t.images.typeNotAllowed })
    expect(called).toBe(false)
  })
})

describe('the dashboard refuses pictures', () => {
  const ctx = { dashboardSheetId: 'dash', activeSheetId: 'dash', visibleContentSheetIds: ['s1'] }
  it('refuses inserting a picture over or in a cell while the dashboard is shown; allows it on a sheet', () => {
    for (const id of ['sheet.command.insert-float-image', 'sheet.command.insert-cell-image']) {
      expect(guardDashboardCommand(id, undefined, ctx)).toEqual({ kind: 'refuse', message: t.dashboard.sheet.readOnly })
      expect(guardDashboardCommand(id, undefined, { ...ctx, activeSheetId: 's1' })).toEqual({ kind: 'allow' })
    }
  })
})

describe('cellText in the editor reads a picture as no text, as sheet-model does', () => {
  it('ignores the placeholder of a picture and the empty lines around it', async () => {
    const { cellText } = await import('../../src/sync/cells')
    const picture = { drawings: { a: { source: '/x' } }, drawingsOrder: ['a'], body: { dataStream: '\r\b\r\n' } }
    expect(cellText({ p: picture } as never)).toBe('')
    expect(cellText({ p: { ...picture, body: { dataStream: '\r\b\rإعداد الخطة\r\n' } } } as never)).toBe('إعداد الخطة')
    expect(cellText({ v: 'نص' })).toBe('نص')
  })
})
