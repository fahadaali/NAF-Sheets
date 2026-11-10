import { describe, expect, it } from 'vitest'
import {
  applyAssigneeEdit,
  bcIdsOf,
  computeAutoAssignees,
  DEFAULT_AUTO_ASSIGN_SETTINGS,
  effectiveAssignees,
  ERROR_MESSAGES,
  isAutoAssignmentEcho,
  makeAutomatic,
  mergeRemoteAssignees,
  normalizeAssignees,
  sameAssigneeList,
  validateAssignees,
} from '../src'
import {
  AHMED,
  BADR,
  DANA,
  external,
  FAHAD,
  follower,
  JUMANA,
  KHALID,
  localSubtask,
  localTodo,
  person,
  SARA,
} from './fixtures'

describe('assignee sets (§8.2)', () => {
  it('sends people and followers to Basecamp, never externals', () => {
    expect(bcIdsOf([external(SARA), follower(FAHAD), person(BADR), person(AHMED), person(BADR)])).toEqual([AHMED, BADR, FAHAD])
  })

  it('normalises: one entry per person, direct beats follower, orphan followers become assignees', () => {
    expect(normalizeAssignees([follower(AHMED), external(SARA), person(AHMED), external(SARA)])).toEqual([
      person(AHMED),
      external(SARA),
    ])
    expect(normalizeAssignees([follower(FAHAD), person(BADR)])).toEqual([person(FAHAD), person(BADR)])
  })

  it('refuses an external-only set with a stable code and an Arabic message', () => {
    const error = validateAssignees([external(SARA), external(KHALID)])
    expect(error?.code).toBe('external_requires_follower')
    expect(error?.message).toBe(ERROR_MESSAGES.external_requires_follower)
    expect(error?.message).toMatch(/[؀-ۿ]/)
    expect(validateAssignees([external(SARA), follower(FAHAD)])).toBeNull()
    expect(validateAssignees([external(SARA), person(BADR)])).toBeNull()
    expect(validateAssignees([])).toBeNull()
  })

  it('refuses a follower who is not a project member when the member list is known', () => {
    expect(validateAssignees([external(SARA), follower(FAHAD)], new Set([AHMED]))?.code).toBe('follower_not_project_member')
    expect(validateAssignees([external(SARA), follower(FAHAD)], new Set([FAHAD]))).toBeNull()
  })

  it('merges Basecamp ids: externals always kept, follower role kept, missing people removed', () => {
    const merged = mergeRemoteAssignees([external(SARA), follower(FAHAD), person(AHMED)], [FAHAD, JUMANA], 'manual')
    expect(merged).toEqual([external(SARA), follower(FAHAD), person(JUMANA)])
    expect(mergeRemoteAssignees([external(SARA), follower(FAHAD)], [], 'manual')).toEqual([external(SARA)])
  })

  it('compares lists regardless of order', () => {
    expect(sameAssigneeList([person(AHMED), external(SARA)], [external(SARA), person(AHMED)])).toBe(true)
    expect(sameAssigneeList([person(AHMED)], [person(AHMED, 'auto')])).toBe(false)
  })
})

describe('computeAutoAssignees (§8.1)', () => {
  const settings = DEFAULT_AUTO_ASSIGN_SETTINGS
  const parent = localTodo({ assignees: [], assignMode: 'auto' })

  it('is the de-duplicated union in subtask order, marked auto', () => {
    const subs = [
      localSubtask({ uid: 's2', position: 2, assignees: [person(BADR), person(AHMED)] }),
      localSubtask({ uid: 's1', position: 1, assignees: [person(AHMED)] }),
    ]
    expect(computeAutoAssignees(parent, subs, settings)).toEqual([person(AHMED, 'auto'), person(BADR, 'auto')])
  })

  it('includes externals (without a second e-mail) and followers; a direct assignment beats a follower role', () => {
    const subs = [
      localSubtask({ uid: 's1', position: 1, assignees: [external(SARA), follower(FAHAD)] }),
      localSubtask({ uid: 's2', position: 2, assignees: [person(FAHAD), external(SARA)] }),
      localSubtask({ uid: 's3', position: 3, assignees: [external(KHALID), follower(JUMANA)] }),
    ]
    expect(computeAutoAssignees(parent, subs, settings)).toEqual([
      external(SARA, 'auto', false),
      person(FAHAD, 'auto'),
      external(KHALID, 'auto', false),
      follower(JUMANA, 'auto'),
    ])
  })

  it('ignores other parents and, when set, completed subtasks', () => {
    const subs = [
      localSubtask({ uid: 's1', assignees: [person(AHMED)], completed: true }),
      localSubtask({ uid: 's2', position: 2, assignees: [person(BADR)] }),
      localSubtask({ uid: 's3', parentUid: 'other', assignees: [person(DANA)] }),
    ]
    expect(bcIdsOf(computeAutoAssignees(parent, subs, settings))).toEqual([AHMED, BADR])
    expect(bcIdsOf(computeAutoAssignees(parent, subs, { ...settings, excludeCompletedSubtasks: true }))).toEqual([BADR])
  })

  it('a to-do without subtasks and without assignees stays unassigned', () => {
    expect(computeAutoAssignees(parent, [], settings)).toEqual([])
  })

  it('effectiveAssignees uses the union only in auto mode with the sheet setting on', () => {
    const subs = [localSubtask({ assignees: [person(BADR)] })]
    expect(effectiveAssignees(parent, subs, settings)).toEqual([person(BADR, 'auto')])
    expect(effectiveAssignees(parent, subs, { ...settings, enabled: false })).toEqual([])
    const manual = localTodo({ assignees: [person(DANA)], assignMode: 'manual' })
    expect(effectiveAssignees(manual, subs, settings)).toEqual([person(DANA)])
  })

  it('recognises its own update coming back and a human edit', () => {
    const union = [person(AHMED, 'auto'), external(SARA, 'auto', false), follower(FAHAD, 'auto')]
    expect(isAutoAssignmentEcho([FAHAD, AHMED], union)).toBe(true)
    expect(isAutoAssignmentEcho([AHMED], union)).toBe(false)
  })
})

describe('applyAssigneeEdit (mode transitions)', () => {
  const subs = [localSubtask({ assignees: [person(BADR)] })]

  it('a manual assignment on a to-do switches it to manual', () => {
    const r = applyAssigneeEdit(localTodo({ assignees: [], assignMode: 'auto' }), [person(DANA, 'auto')], { subtasks: subs })
    expect(r).toEqual({ ok: true, value: { assignMode: 'manual', assignees: [person(DANA)] } })
  })

  it('emptying the cell switches back to auto and recomputes at once', () => {
    const r = applyAssigneeEdit(localTodo({ assignees: [person(DANA)], assignMode: 'manual' }), [], { subtasks: subs })
    expect(r).toEqual({ ok: true, value: { assignMode: 'auto', assignees: [person(BADR, 'auto')] } })
  })

  it('with the sheet setting off, an emptied cell stays empty', () => {
    const r = applyAssigneeEdit(localTodo(), [], { subtasks: subs, settings: { enabled: false, excludeCompletedSubtasks: false } })
    expect(r).toEqual({ ok: true, value: { assignMode: 'auto', assignees: [] } })
  })

  it('a subtask keeps its mode', () => {
    const r = applyAssigneeEdit(localSubtask({ assignMode: 'auto' }), [person(AHMED)])
    expect(r.ok && r.value.assignMode).toBe('auto')
  })

  it('refuses an external-only assignment and changes nothing', () => {
    const r = applyAssigneeEdit(localTodo(), [external(SARA)])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('external_requires_follower')
  })

  it('makeAutomatic («اجعله تلقائياً») recomputes from the subtasks', () => {
    expect(makeAutomatic(localTodo(), subs, DEFAULT_AUTO_ASSIGN_SETTINGS)).toEqual({
      assignMode: 'auto',
      assignees: [person(BADR, 'auto')],
    })
  })
})
