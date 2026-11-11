import { describe, expect, it } from 'vitest'
import { dashboardMutationProblem, imagePath, parseImagePath, roomMutationClass, sniffImageType } from '../src/index'

describe('image paths', () => {
  it('round-trips a workbook id and an image id, relative or absolute', () => {
    const id = 'a'.repeat(32)
    const path = imagePath('wb 1/x', id)
    expect(path).toBe(`/api/workbooks/wb%201%2Fx/images/${id}`)
    expect(parseImagePath(path)).toEqual({ workbookId: 'wb 1/x', imageId: id })
    expect(parseImagePath(`https://sheets.naflaw.sa${path}?v=1`)).toEqual({ workbookId: 'wb 1/x', imageId: id })
  })
  it('refuses anything else', () => {
    for (const s of [null, 42, '', 'data:image/png;base64,AA', 'https://example.com/a.png', '/api/workbooks//images/' + 'a'.repeat(32), '/api/workbooks/w/images/ABC', '/api/workbooks/w/attachments/x']) {
      expect(parseImagePath(s)).toBeNull()
    }
  })
})

describe('sniffImageType', () => {
  const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(16).fill(0)])
  it('recognises png, jpeg, gif and webp from their signatures', () => {
    expect(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png')
    expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg')
    expect(sniffImageType(new TextEncoder().encode('GIF89a....'))).toBe('image/gif')
    expect(sniffImageType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
  })
  it('refuses SVG, HTML, BMP and empty input whatever their name', () => {
    expect(sniffImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull()
    expect(sniffImageType(new TextEncoder().encode('<!doctype html><script>'))).toBeNull()
    expect(sniffImageType(bytes(0x42, 0x4d))).toBeNull()
    expect(sniffImageType(new Uint8Array())).toBeNull()
  })
})

describe('the drawing mutation in the room', () => {
  it('is plugin data on one sheet, and refused on the dashboard sheet', () => {
    expect(roomMutationClass('sheet.mutation.set-drawing-apply')).toBe('resource')
    const params = { unitId: 'u', subUnitId: 'dash', op: [], objects: {}, type: 0 }
    expect(dashboardMutationProblem('sheet.mutation.set-drawing-apply', params, 'dash', roomMutationClass)).toBe('edit')
    expect(dashboardMutationProblem('sheet.mutation.set-drawing-apply', { ...params, subUnitId: 'other' }, 'dash', roomMutationClass)).toBeNull()
  })
  it('the background-image and transformer mutations stay outside the allow-list', () => {
    expect(roomMutationClass('sheet.mutation.set-worksheet-background-image')).toBeNull()
    expect(roomMutationClass('sheet.operation.clear-drawing-transformer')).toBeNull()
  })
})
