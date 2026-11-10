import { describe, expect, it } from 'vitest'
import type { TaskUid } from '@naf-sheets/shared'
import { ERROR_MESSAGES, indentRow, isValidHierarchy, moveRow, outdentRow, renumber, type HierarchyRow } from '../src'

const main = (uid: TaskUid): HierarchyRow => ({ uid, parentUid: null, level: 0, position: 0 })
const child = (uid: TaskUid, parentUid: TaskUid): HierarchyRow => ({ uid, parentUid, level: 1, position: 0 })

/** P1 [a, b], P2 [c], P3 */
const sheet = (): HierarchyRow[] => renumber([main('P1'), child('a', 'P1'), child('b', 'P1'), main('P2'), child('c', 'P2'), main('P3')])

const outline = (rows: readonly HierarchyRow[]): string =>
  rows.map((r) => (r.level === 0 ? `${r.uid}#${r.position}` : `  ${r.uid}<${r.parentUid}#${r.position}`)).join(' | ')

function value<T>(r: { ok: true; value: T } | { ok: false }): T {
  if (!r.ok) throw new Error('expected ok')
  return r.value
}

describe('renumber', () => {
  it('numbers to-dos in the sheet and subtasks within their to-do, from 1', () => {
    expect(outline(sheet())).toBe('P1#1 |   a<P1#1 |   b<P1#2 | P2#2 |   c<P2#1 | P3#3')
    expect(isValidHierarchy(sheet())).toBe(true)
  })

  it('keeps row objects that did not change', () => {
    const rows = sheet()
    const again = renumber(rows)
    expect(again.every((r, i) => r === rows[i])).toBe(true)
  })
})

describe('indentRow (Tab)', () => {
  it('makes a to-do the last subtask of the to-do above', () => {
    expect(outline(value(indentRow(sheet(), 'P3')))).toBe('P1#1 |   a<P1#1 |   b<P1#2 | P2#2 |   c<P2#1 |   P3<P2#2')
  })

  it('refuses a third level with an Arabic message', () => {
    const r = indentRow(sheet(), 'b')
    expect(r).toEqual({ ok: false, error: { code: 'third_level_not_allowed', message: ERROR_MESSAGES.third_level_not_allowed } })
    expect(r.ok === false && r.error.message).toMatch(/Basecamp/)
  })

  it('refuses a to-do that has subtasks (they would become a third level)', () => {
    expect(indentRow(sheet(), 'P2')).toMatchObject({ ok: false, error: { code: 'parent_has_subtasks' } })
  })

  it('refuses the first row: no to-do above it', () => {
    expect(indentRow(renumber([main('X'), main('Y')]), 'X')).toMatchObject({ ok: false, error: { code: 'no_parent_above' } })
    expect(indentRow(sheet(), 'zz')).toMatchObject({ ok: false, error: { code: 'row_not_found' } })
  })
})

describe('outdentRow (Shift+Tab)', () => {
  it('a middle subtask becomes a to-do after its former siblings; no other row changes parent', () => {
    expect(outline(value(outdentRow(sheet(), 'a')))).toBe('P1#1 |   b<P1#1 | a#2 | P2#3 |   c<P2#1 | P3#4')
  })

  it('a last subtask stays where it is', () => {
    expect(outline(value(outdentRow(sheet(), 'b')))).toBe('P1#1 |   a<P1#1 | b#2 | P2#3 |   c<P2#1 | P3#4')
  })

  it('a to-do is left as it is', () => {
    expect(outline(value(outdentRow(sheet(), 'P2')))).toBe(outline(sheet()))
  })
})

describe('moveRow (drag)', () => {
  it('moving a to-do moves its subtasks with it', () => {
    expect(outline(value(moveRow(sheet(), 'P1', null)))).toBe('P2#1 |   c<P2#1 | P3#2 | P1#3 |   a<P1#1 |   b<P1#2')
    expect(outline(value(moveRow(sheet(), 'P2', 'P1')))).toBe('P2#1 |   c<P2#1 | P1#2 |   a<P1#1 |   b<P1#2 | P3#3')
  })

  it('a to-do cannot land among another to-do’s subtasks', () => {
    expect(moveRow(sheet(), 'P3', 'b')).toMatchObject({ ok: false, error: { code: 'invalid_move_target' } })
  })

  it('moving a to-do onto itself or its own subtask changes nothing', () => {
    expect(outline(value(moveRow(sheet(), 'P1', 'a')))).toBe(outline(sheet()))
  })

  it('reorders a subtask within its to-do', () => {
    expect(outline(value(moveRow(sheet(), 'b', 'a')))).toBe('P1#1 |   b<P1#1 |   a<P1#2 | P2#2 |   c<P2#1 | P3#3')
  })

  it('a subtask dropped under another to-do changes to-do', () => {
    expect(outline(value(moveRow(sheet(), 'a', 'P3')))).toBe('P1#1 |   b<P1#1 | P2#2 |   c<P2#1 |   a<P2#2 | P3#3')
  })

  it('a subtask cannot be the first row', () => {
    expect(moveRow(sheet(), 'a', 'P1')).toMatchObject({ ok: false, error: { code: 'subtask_needs_parent' } })
  })
})

describe('isValidHierarchy', () => {
  it('rejects orphan subtasks and subtasks out of place', () => {
    expect(isValidHierarchy([child('a', 'P1'), main('P1')])).toBe(false)
    expect(isValidHierarchy([main('P1'), main('P2'), child('a', 'P1')])).toBe(false)
  })
})
