import { readTasks, UNSYNCED_NOTE } from '@naf-sheets/sheet-model'
import { ERROR_MESSAGES } from '@naf-sheets/sync-engine'
import type { AssigneeOptionsResponse, BcPerson, ConflictRecord, WorkbookSyncResponse } from '@naf-sheets/shared'
import type { IWorkbookData } from '@univerjs/core'
import { describe, expect, it } from 'vitest'
import { ambiguousNames, chipsOf, choicesOf, filterOptions, formatAssigneeCell, validateChoices, type Choice } from '../../src/sync/assignees'
import { snapshotReader } from '../../src/sync/cells'
import { conflictCells, formatConflictValue } from '../../src/sync/conflicts'
import { PendingDeletions, uidsInSnapshot } from '../../src/sync/deletions'
import { sheetLayout } from '../../src/sync/layout'
import { prepareSyncedSheets, statusRuleId } from '../../src/sync/prepare'
import { readTaskRows } from '../../src/sync/rows'
import { Poller, rowIndicators } from '../../src/sync/sync-state'
import { t } from '../../src/strings'
import { COL, META, PLAN, put, SHEET, sheetOf, syncedWorkbook } from './sync-fixtures'

const person = (id: number, name: string): BcPerson => ({ id, name, email: null, avatarUrl: null, personableType: 'User', client: false })
const OPTIONS: AssigneeOptionsResponse = {
  projectPeople: [person(1, 'فهد العتيبي'), person(2, 'سارة القحطاني')],
  accountPeople: [person(3, 'نورة السبيعي')],
  externals: [{ id: 'ext-1', name: 'مكتب التصميم', organization: 'وكالة', email: null, phone: null }],
  refreshedAt: '2026-11-10T09:00:00Z',
}

describe('assignee cell (spec §5.2, §8.2)', () => {
  it('the text the editor writes is what sheet-model readTasks reads back as the chosen people', () => {
    const workbook = syncedWorkbook([{ title: 'A' }, { title: 'B' }])
    const text = formatAssigneeCell(['فهد العتيبي', 'مكتب التصميم', 'سارة القحطاني'], false)
    expect(text).toBe('فهد العتيبي، مكتب التصميم، سارة القحطاني')
    put(workbook, 1, { [COL.assignees]: { v: text, t: 1 } })
    put(workbook, 2, { [COL.assignees]: { v: formatAssigneeCell(['سارة القحطاني'], true), t: 1 } })
    const directory = { people: [...OPTIONS.projectPeople, ...OPTIONS.accountPeople], externals: OPTIONS.externals }
    const read = readTasks(workbook, SHEET, PLAN, { directory })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.value.issues).toEqual([])
    expect(read.value.tasks[0]?.assignees).toEqual([
      { kind: 'bc_person', bcPersonId: 1, source: 'manual' },
      { kind: 'external', externalContactId: 'ext-1', source: 'manual', notifyEmail: false },
      { kind: 'bc_person', bcPersonId: 2, source: 'manual' },
    ])
    expect(read.value.tasks[1]?.assignees).toEqual([{ kind: 'bc_person', bcPersonId: 2, source: 'manual' }])
    expect(formatAssigneeCell([], false)).toBe('')
  })

  it('chips: project members, account members (grey), externals, unknown names; automatic ones dotted', () => {
    const chips = chipsOf('فهد العتيبي، نورة السبيعي, مكتب التصميم، شخص مجهول', OPTIONS, true)
    expect(chips.map((c) => [c.name, c.kind, c.auto])).toEqual([
      ['فهد العتيبي', 'project', true],
      ['نورة السبيعي', 'account', true],
      ['مكتب التصميم', 'external', true],
      ['شخص مجهول', 'unknown', true],
    ])
    expect(choicesOf('سارة القحطاني، شخص مجهول', OPTIONS).map((c) => c.kind === 'person' && c.person.id)).toEqual([2])
  })

  it('externals only need an internal follower (the engine’s message); duplicate names are flagged', () => {
    const external: Choice = { kind: 'external', contact: OPTIONS.externals[0]! }
    const member: Choice = { kind: 'person', person: OPTIONS.projectPeople[0]!, inProject: true }
    expect(validateChoices([external])).toBe(ERROR_MESSAGES.external_requires_follower)
    expect(validateChoices([external, member])).toBeNull()
    expect(validateChoices([])).toBeNull()
    const twins = { ...OPTIONS, accountPeople: [person(9, 'فهد العتيبي')] }
    expect(ambiguousNames([member], twins)).toEqual(['فهد العتيبي'])
    expect(ambiguousNames([member], OPTIONS)).toEqual([])
  })

  it('search filters each section by name, e-mail or organisation', () => {
    const found = filterOptions(OPTIONS, 'سارة')
    expect(found.project.map((p) => p.id)).toEqual([2])
    expect(found.account).toEqual([])
    expect(filterOptions(OPTIONS, 'وكالة').externals.map((e) => e.id)).toEqual(['ext-1'])
  })
})

describe('row sync indicators (spec §5.2)', () => {
  const workbook = syncedWorkbook([{ title: 'A' }, { title: 'B' }, { title: 'C' }, { title: 'D' }, { title: 'E' }])
  const reader = snapshotReader(sheetOf(workbook))
  const rows = readTaskRows(reader, sheetLayout(reader, META)!)
  const task = (uid: string, over: Partial<WorkbookSyncResponse['tasks'][number]> = {}) => ({
    uid,
    sheetId: META.id,
    state: 'synced' as const,
    message: null,
    remoteStatus: 'active' as const,
    bcUrl: `https://3.basecamp.com/1/buckets/2/todos/${uid}`,
    assignMode: 'manual' as const,
    ...over,
  })
  const info: WorkbookSyncResponse = {
    state: 'error',
    lastSuccessAt: null,
    counts: { pending: 1, error: 1, conflict: 1 },
    notice: null,
    tasks: [
      task('u-1'),
      task('u-2', { state: 'pending' }),
      task('u-3', { state: 'error', message: 'تعذّر الإرسال.' }),
      task('u-4', { state: 'conflict', message: 'تعارض.', remoteStatus: 'trashed' }),
    ],
  }

  it('one state per row; deleted in Basecamp first; unknown rows are pending', () => {
    const map = rowIndicators(info, rows)
    expect([1, 2, 3, 4, 5].map((r) => map.get(r)?.state)).toEqual(['synced', 'pending', 'error', 'deleted', 'pending'])
    expect(map.get(3)?.message).toBe('تعذّر الإرسال.')
    expect(map.get(1)?.bcUrl).toContain('/todos/u-1')
    expect(rowIndicators({ ...info, state: 'unlinked' }, rows).size).toBe(0)
    expect(rowIndicators(null, rows).size).toBe(0)
  })

  it('phase 5: carries the comment and file counts (absent from older payloads: none known)', () => {
    const counted: WorkbookSyncResponse = { ...info, tasks: [task('u-1', { commentsCount: 3, attachmentsCount: 2 }), task('u-2', { commentsCount: null })] }
    const map = rowIndicators(counted, rows)
    expect([map.get(1)?.commentsCount, map.get(1)?.attachmentsCount]).toEqual([3, 2])
    expect([map.get(2)?.commentsCount, map.get(2)?.attachmentsCount]).toEqual([null, 0])
    expect([map.get(5)?.commentsCount, map.get(5)?.attachmentsCount]).toEqual([null, 0])
  })

  it('the poller runs at once, every interval after the last run, never twice at a time, and once more on a poke', async () => {
    const timers: Array<{ fn: () => void; ms: number }> = []
    const clock = { setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }), clearTimeout: () => undefined, now: () => 0 }
    let runs = 0
    let release: () => void = () => undefined
    const poller = new Poller(
      () =>
        new Promise<void>((resolve) => {
          runs += 1
          release = resolve
        }),
      10_000,
      clock,
    )
    poller.start()
    expect(runs).toBe(1)
    poller.poke()
    poller.poke()
    expect(runs).toBe(1) // still running: one more run queued
    release()
    await Promise.resolve()
    await Promise.resolve()
    expect(runs).toBe(2)
    release()
    await Promise.resolve()
    await Promise.resolve()
    expect(timers.at(-1)?.ms).toBe(10_000)
    poller.stop()
    timers.at(-1)?.fn()
    expect(runs).toBe(2)
  })
})

describe('confirmed deletions (SaveSnapshotRequest.confirmedDeletions)', () => {
  it('sends a confirmed uid only while its row is gone; undo before the save drops it', () => {
    const pending = new PendingDeletions()
    pending.add(['u-2', 'u-3'])
    expect(pending.forSnapshot(new Set(['u-1']))).toEqual(['u-2', 'u-3'])
    // Undo brought u-3 back before the save.
    expect(pending.forSnapshot(new Set(['u-1', 'u-3']))).toEqual(['u-2'])
    pending.acknowledge(['u-2'])
    expect(pending.size).toBe(0)
  })

  it('reads the uids of a snapshot’s synced sheets', () => {
    const workbook = syncedWorkbook([{ title: 'A' }, { title: 'B' }])
    expect([...uidsInSnapshot(workbook, [META])]).toEqual(['u-1', 'u-2'])
    expect(uidsInSnapshot(workbook, [{ ...META, syncMode: 'local' }]).size).toBe(0)
  })
})

describe('conflicts (spec §9.1)', () => {
  const conflict = (over: Partial<ConflictRecord>): ConflictRecord => ({
    id: 'c-1',
    sheetId: META.id,
    uid: 'u-2',
    field: 'dueOn',
    localValue: '2026-11-20',
    remoteValue: '2026-11-25',
    winner: 'remote',
    localChangedAt: '2026-11-10T08:00:00Z',
    remoteUpdatedAt: '2026-11-10T08:05:00Z',
    createdAt: '2026-11-10T08:06:00Z',
    ...over,
  })

  it('each conflict sits on its row’s field column (the title for order and list)', () => {
    const workbook = syncedWorkbook([{ title: 'A' }, { title: 'B' }])
    const reader = snapshotReader(sheetOf(workbook))
    const layout = sheetLayout(reader, META)!
    const cells = conflictCells([conflict({}), conflict({ id: 'c-2', field: 'position' }), conflict({ id: 'c-3', uid: 'gone' })], readTaskRows(reader, layout), layout)
    expect(cells.map((c) => [c.conflict.id, c.row, c.column])).toEqual([
      ['c-1', 2, COL.due],
      ['c-2', 2, COL.title],
    ])
  })

  it('values read in Arabic', () => {
    expect(formatConflictValue('completed', true)).toBe(t.conflicts.completedTrue)
    expect(formatConflictValue('dueOn', null)).toBe(t.conflicts.emptyValue)
    expect(formatConflictValue('notesHtml', '<div>سطر<br>ثانٍ</div>')).toBe('سطر ثانٍ')
    expect(formatConflictValue('assignees', [1, 99], OPTIONS)).toBe(`فهد العتيبي، ${t.conflicts.person(99)}`)
    expect(formatConflictValue('assignees', [{ kind: 'external', externalContactId: 'ext-1', source: 'manual', notifyEmail: true }], OPTIONS)).toBe('مكتب التصميم')
  })
})

describe('preparing synced sheets before Univer loads them', () => {
  it('widens the row header and makes an empty status column a checkbox that readTasks reads', () => {
    const workbook = syncedWorkbook([{ title: 'A' }, { title: 'B' }])
    const prepared = prepareSyncedSheets(workbook as Partial<IWorkbookData>, [META], { rowHeaderWidth: 64 })
    expect(prepared.sheets?.[SHEET]?.rowHeader?.width).toBe(64)
    expect(workbook.sheets[SHEET]?.rowHeader).toBeUndefined()
    const rules = JSON.parse(prepared.resources!.find((r) => r.name === 'SHEET_DATA_VALIDATION_PLUGIN')!.data) as Record<string, Array<{ uid: string; type: string }>>
    expect(rules[SHEET]?.map((r) => [r.uid, r.type])).toEqual([[statusRuleId(SHEET), 'checkbox']])
    // The checkbox's checked value (Univer writes 1) reads as completed.
    const ticked = structuredClone(prepared) as typeof workbook
    put(ticked, 2, { [COL.status]: { v: 1, t: 2 } })
    const read = readTasks(ticked, SHEET, { ...PLAN, completedValues: ['منجز'] })
    expect(read.ok && read.value.tasks.map((x) => x.completed)).toEqual([false, true])
  })

  it('a status column with words is left alone, and so are local sheets', () => {
    const workbook = syncedWorkbook([{ title: 'A', cells: { [COL.status]: { v: 'منجز' } } }])
    const prepared = prepareSyncedSheets(workbook as Partial<IWorkbookData>, [META], { rowHeaderWidth: 64 })
    expect(prepared.resources).toBeUndefined()
    const local = prepareSyncedSheets(workbook as Partial<IWorkbookData>, [{ ...META, syncMode: 'local' }], { rowHeaderWidth: 64 })
    expect(local.sheets?.[SHEET]?.rowHeader).toBeUndefined()
  })
})

describe('strings', () => {
  it('the unsynced-cell tooltip says what sheet-model’s note says', () => {
    expect(t.unsynced.tooltip).toBe(UNSYNCED_NOTE)
  })
})
