// The help text of an imported validation rule (apps/api OPEN_QUESTIONS.md
// "Google import" G32): Univer 1.4.0 stores `prompt` but never shows it; the
// editor shows it with Univer's cell alert (src/editor/validation-prompt.ts).

import { describe, expect, it } from 'vitest'
import { PROMPT_TITLE, promptOf } from '../../src/editor/validation-prompt'

describe('promptOf', () => {
  it('shows the message under its own title, or under «تلميح»', () => {
    expect(promptOf({ prompt: 'اختر حالة المهمة', promptTitle: 'الحالة', showInputMessage: true })).toEqual({ title: 'الحالة', message: 'اختر حالة المهمة' })
    expect(promptOf({ prompt: ' اختر حالة المهمة ', showInputMessage: true })).toEqual({ title: PROMPT_TITLE, message: 'اختر حالة المهمة' })
    expect(PROMPT_TITLE).toBe('تلميح')
  })

  it('shows nothing without a message, or when the rule turns it off', () => {
    expect(promptOf(undefined)).toBeNull()
    expect(promptOf({ promptTitle: 'الحالة' })).toBeNull()
    expect(promptOf({ prompt: '   ' })).toBeNull()
    expect(promptOf({ prompt: 'نص', showInputMessage: false })).toBeNull()
  })
})
