// The pure decisions of the attachment cell editor (spec §5.2, §10) and of
// the comments in the details panel (§12.1 item 5).

import { describe, expect, it } from 'vitest'
import { COMMENT_MAX_LENGTH } from '@naf-sheets/shared'
import { checkFile, commentProblem, dragHasFiles, filesOf, focusAfterRemoval, formatBytes, removalSentence, stateTone, uploadPercent } from '../../src/attachments/model'
import { uploadPath } from '../../src/lib/upload'

const ARABIC = /[؀-ۿ]/
const NO_ARABIC_DIGITS = /^[^٠-٩۰-۹]*$/

describe('formatBytes', () => {
  it('writes sizes with Latin digits and Arabic units', () => {
    expect(formatBytes(100 * 1024 * 1024)).toBe('100 ميغابايت')
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 ميغابايت')
    expect(formatBytes(1024)).toBe('1 كيلوبايت')
    expect(formatBytes(1536)).toBe('1.5 كيلوبايت')
    expect(formatBytes(900)).toBe('900 بايت')
    expect(formatBytes(0)).toBe('0 بايت')
    for (const n of [0, 1, 999, 2048, 5_000_000, 104_857_600]) expect(formatBytes(n)).toMatch(NO_ARABIC_DIGITS)
  })
})

describe('checkFile', () => {
  it('refuses a file over the limit and an empty file with an Arabic sentence that names it and says what to do', () => {
    const big = checkFile({ name: 'عرض.mp4', size: 2048 }, 1024)
    expect(big).toContain('عرض.mp4')
    expect(big).toContain('1 كيلوبايت')
    expect(big).toMatch(ARABIC)
    expect(checkFile({ name: 'فارغ.txt', size: 0 }, 1024)).toContain('فارغ')
    expect(checkFile({ name: 'a.pdf', size: 1024 }, 1024)).toBeNull()
  })
})

describe('upload progress and states', () => {
  it('reports whole percents, clamped', () => {
    expect(uploadPercent({ loaded: 0, size: 200 })).toBe(0)
    expect(uploadPercent({ loaded: 101, size: 200 })).toBe(51)
    expect(uploadPercent({ loaded: 999, size: 200 })).toBe(100)
    expect(uploadPercent({ loaded: 0, size: 0 })).toBe(100)
  })

  it('gives each state a tone (always shown with a label and an icon)', () => {
    expect(stateTone('attached')).toBe('success')
    expect(stateTone('uploading')).toBe('info')
    expect(stateTone('local_only')).toBe('neutral')
    expect(stateTone('failed')).toBe('danger')
  })

  it('the confirmation says Basecamp loses the file too, unless it never reached Basecamp', () => {
    expect(removalSentence({ filename: 'a.pdf', state: 'attached' })).toContain('Basecamp')
    expect(removalSentence({ filename: 'a.pdf', state: 'local_only' })).not.toContain('Basecamp')
    expect(removalSentence({ filename: 'a.pdf', state: 'failed' })).not.toContain('Basecamp')
    expect(removalSentence({ filename: 'a.pdf', state: 'attached' })).toContain('30')
  })

  it('moves the focus to the next chip after a removal, else the previous one', () => {
    expect(focusAfterRemoval(['a', 'b', 'c'], 'b')).toBe('c')
    expect(focusAfterRemoval(['a', 'b', 'c'], 'c')).toBe('b')
    expect(focusAfterRemoval(['a'], 'a')).toBeNull()
    expect(focusAfterRemoval(['a', 'b'], 'x')).toBe('a')
  })
})

describe('drag and drop, file lists', () => {
  it('reads files of a list and only treats a drag with files as a drop target', () => {
    const files = [{ name: 'a' }, { name: 'b' }] as unknown as File[]
    expect(filesOf({ length: 2, item: (i) => files[i] ?? null }).map((f) => f.name)).toEqual(['a', 'b'])
    expect(filesOf(null)).toEqual([])
    expect(dragHasFiles(['Files'])).toBe(true)
    expect(dragHasFiles(['text/plain'])).toBe(false)
    expect(dragHasFiles(undefined)).toBe(false)
  })

  it('the upload path carries the encoded name', () => {
    expect(uploadPath('wb 1', 'u/2', 'خطة الحملة.pdf')).toBe(`/api/workbooks/wb%201/tasks/u%2F2/attachments?name=${encodeURIComponent('خطة الحملة.pdf')}`)
  })
})

describe('commentProblem', () => {
  it('refuses empty and over-long comments, in Arabic', () => {
    expect(commentProblem('   ')).toMatch(ARABIC)
    expect(commentProblem('x'.repeat(COMMENT_MAX_LENGTH + 1))).toContain(String(COMMENT_MAX_LENGTH))
    expect(commentProblem('  تم  ')).toBeNull()
  })
})
