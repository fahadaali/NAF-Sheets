// A linked tab → task rows (docs/station-plan.md §3, §11-ج).
//
// Row rules, top to bottom after the header row:
// - «المهمة» has text → a subtask of the nearest to-do row above it
//   (owner decision 4: position decides the parent, not the repeated title in
//   «المهمة الرئيسية»; a stale repeated title is rewritten, see `fixes`).
// - otherwise «المهمة الرئيسية» has text → a to-do.
// - otherwise the row is ignored.
//
// Row identity is not in the cells: the caller reads it from the row's
// developer metadata and passes it in `identities`. A row without one is new
// and gets `newUid()`; the caller writes the uid back as row metadata.
//
// A row with a blocking issue is held back: it is not in `tasks`, so nothing
// is sent to Basecamp for it until the sheet is fixed (an unknown name must
// never clear Basecamp's assignees).

import type { IsoDateTime, LocalTask, TaskLevel, TaskUid } from '@naf-sheets/shared'
import { cellText, readDate, textCell, type CellValue } from './cells'
import type { TabColumns } from './columns'
import { assigneesForRole, type PeopleMap, type RoleNames } from './people'
import { isDone } from './status'

export interface RowIdentity {
  uid: TaskUid
  /** Basecamp id once created; `null` before. */
  bcId: number | null
  /** The level stored with the identity; a row cannot switch between to-do and subtask. */
  level?: TaskLevel
  /**
   * Fields Basecamp has but the sheet has no column for, carried from the last
   * synced base so a full to-do PUT (which clears omitted fields) keeps them.
   */
  carry?: Pick<LocalTask, 'notesHtml' | 'startsOn'>
  /** The record was deleted, trashed or archived in Basecamp and the row already carries the note. */
  deletedRemotely?: boolean
}

export interface ReadTabInput {
  /** The tab's values, header row first (UNFORMATTED_VALUE, SERIAL_NUMBER). */
  values: readonly (readonly CellValue[])[]
  columns: TabColumns
  roles: RoleNames
  people: PeopleMap
  /** 0-based row index (header = 0) → identity from the row's metadata. */
  identities: ReadonlyMap<number, RowIdentity>
  newUid: () => TaskUid
  /** Platform id of the linked tab (`LocalTask.sheetId`). */
  sheetId: string
  /** When this read noticed the change (Drive notification time); used for last-writer-wins. */
  changedAt: IsoDateTime | null
}

export interface TabRow {
  /** 0-based row index in the tab (header = 0). */
  row: number
  uid: TaskUid
  bcId: number | null
  level: TaskLevel
  parentUid: TaskUid | null
  /** Text of «المهمة الرئيسية» as found in this row. */
  mainCell: string
  /** Text of «الحالة» as found. */
  status: string
}

export type TabIssueCode =
  | 'subtask_without_main'
  | 'role_unknown'
  | 'role_without_name'
  | 'name_unmapped'
  | 'date_unreadable'
  | 'level_changed'
  | 'duplicate_identity'
  | 'parent_held'
  | 'role_empty'
  | 'copy_of_existing'
  | 'titles_cleared'

export interface TabIssue {
  code: TabIssueCode
  row: number
  /** `true`: the row is held back from Basecamp until fixed. */
  blocking: boolean
  message: string
  /** What the issue is about, without the row (title, name, cell text): groups rows for one alert. */
  subject?: string
}

/** A cell the platform rewrites in the sheet (0-based row and column). */
export interface CellEdit {
  row: number
  column: number
  value: string | number | null
}

export interface ReadTabResult {
  /** Every classified row, held-back ones included, in sheet order. */
  rows: TabRow[]
  /** Rows to sync, in sheet order (to-do, its subtasks, next to-do …). */
  tasks: LocalTask[]
  issues: TabIssue[]
  /** Stale repeated to-do titles on subtask rows, to rewrite (decision 4). */
  fixes: CellEdit[]
  /** Rows that got a new uid: write it to the row's metadata. */
  newIdentities: { row: number; uid: TaskUid }[]
  /**
   * To-dos whose «الموعد» is empty: their due date is the latest of their
   * subtasks' (owner decision, 2026-11-15, option أ). A date written in the
   * to-do's own row wins.
   */
  autoDue: Set<TaskUid>
}

const human = (row: number): number => row + 1

/** A task as its row reads: a to-do by its title, a subtask by its to-do's title (repeated in its row) and its own. */
function taskKey(level: TaskLevel, main: string, sub: string): string {
  return level === 0 ? `0\u0000${main}` : `1\u0000${main}\u0000${sub}`
}

export function readTab(input: ReadTabInput): ReadTabResult {
  const { values, columns } = input
  const result: ReadTabResult = { rows: [], tasks: [], issues: [], fixes: [], newIdentities: [], autoDue: new Set() }
  /** Latest readable subtask date per to-do uid (held subtasks included: their date is still the plan). */
  const latestSubDue = new Map<TaskUid, string>()
  const usedUids = new Set<TaskUid>()
  /** `cleared`: the to-do's title cells were emptied; its subtasks keep it as their parent, unrewritten. */
  let currentMain: { row: TabRow; title: string; held: boolean; cleared?: boolean } | null = null
  let mainPosition = 0
  let subPosition = 0

  const issue = (code: TabIssueCode, row: number, blocking: boolean, message: string, subject?: string): void => {
    result.issues.push(subject === undefined ? { code, row, blocking, message } : { code, row, blocking, message, subject })
  }

  // Titles of the tasks already in Basecamp, as their rows read now: a new row
  // with one of them is a copy (plan §10-2; owner, 2026-11-17).
  const syncedKeys = new Set<string>()
  const seenUids = new Set<TaskUid>()
  for (let r = 1; r < values.length; r++) {
    const known = input.identities.get(r)
    // The first row with an identity is the task; a later one is its copy (metadata copied too).
    if (known?.bcId == null || seenUids.has(known.uid)) continue
    seenUids.add(known.uid)
    const cells = values[r] ?? []
    const main = cellText(cells[columns.main])
    const sub = cellText(cells[columns.sub])
    if (sub !== '') syncedKeys.add(taskKey(1, main, sub))
    else if (main !== '') syncedKeys.add(taskKey(0, main, ''))
  }

  for (let r = 1; r < values.length; r++) {
    const cells = values[r] ?? []
    const mainText = cellText(cells[columns.main])
    const subText = cellText(cells[columns.sub])
    const level: TaskLevel | null = subText !== '' ? 1 : mainText !== '' ? 0 : null
    if (level === null) {
      // Both title cells emptied on a row whose task is in Basecamp: not a
      // deletion (owner, 2026-11-17; deleting is deleting the row). Kept and held.
      const known = input.identities.get(r)
      if (known !== undefined && known.bcId !== null && !usedUids.has(known.uid)) {
        usedUids.add(known.uid)
        const keptLevel: TaskLevel = known.level ?? 0
        const row: TabRow = {
          row: r,
          uid: known.uid,
          bcId: known.bcId,
          level: keptLevel,
          parentUid: keptLevel === 1 ? (currentMain?.row.uid ?? null) : null,
          mainCell: '',
          status: cellText(cells[columns.status]),
        }
        result.rows.push(row)
        if (keptLevel === 0) {
          mainPosition += 1
          subPosition = 0
          currentMain = { row, title: '', held: true, cleared: true }
        } else {
          subPosition += 1
        }
        issue('titles_cleared', r, true, `الصف ${human(r)}: مُسح عنوان المهمة فتوقفت مزامنتها، ولم تُحذف من Basecamp. أعد العنوان، أو احذف الصف نفسه إن أردت حذفها.`)
      }
      continue
    }

    const identity = identityFor(r, level)
    if (level === 1 && currentMain === null) {
      // Kept in `rows` (so it is not taken for a deleted row), never synced.
      issue('subtask_without_main', r, true, `الصف ${human(r)}: مهمة فرعية بلا مهمة رئيسية فوقها. أضف صف المهمة الرئيسية فوقها.`)
      result.rows.push({ row: r, uid: identity.uid, bcId: identity.bcId, level, parentUid: null, mainCell: mainText, status: cellText(cells[columns.status]) })
      continue
    }

    let blocked = identity.blocked
    const row: TabRow = {
      row: r,
      uid: identity.uid,
      bcId: identity.bcId,
      level,
      parentUid: level === 1 ? currentMain!.row.uid : null,
      mainCell: mainText,
      status: cellText(cells[columns.status]),
    }
    result.rows.push(row)

    if (identity.bcId === null && syncedKeys.has(taskKey(level, mainText, subText))) {
      blocked = true
      const title = level === 0 ? mainText : subText
      issue('copy_of_existing', r, true, `الصف ${human(r)}: نسخة من مهمة موجودة بالعنوان نفسه «${title}»، فلم تُنشأ مرة ثانية. إن كانت مهمة أخرى فغيّر عنوانها، وإلا فاحذف الصف.`, title)
    }

    const due = readDate(cells[columns.due])
    if (!due.ok) {
      issue('date_unreadable', r, true, `الصف ${human(r)}: «${cellText(cells[columns.due])}» ليس تاريخاً مفهوماً. اكتبه بالشكل 2026/11/30، بين سنتي 2000 و2100.`, cellText(cells[columns.due]))
      blocked = true
    }

    const who = assigneesForRole(cells[columns.role], input.roles, input.people)
    if (level === 1 && cellText(cells[columns.role]) === '') {
      // Owner, 2026-11-17: a subtask is never sent with nobody on it; its «القسم» says who.
      blocked = true
      issue('role_empty', r, true, `الصف ${human(r)}: «القسم» فارغ، فلا أحد مسؤول عن هذه المهمة الفرعية. اختر لها مسمى في «القسم».`)
    } else if (!who.ok) {
      blocked = true
      if (who.code === 'role_unknown') {
        issue('role_unknown', r, true, `الصف ${human(r)}: المسمى «${who.role}» غير موجود في تبويب «المسميات». أضفه هناك أو اختر مسمى من القائمة.`, who.role)
      } else if (who.code === 'role_without_name') {
        issue('role_without_name', r, true, `الصف ${human(r)}: المسمى «${who.role}» بلا اسم في تبويب «المسميات». اكتب الاسم أمامه هناك.`, who.role)
      } else {
        issue('name_unmapped', r, true, `الصف ${human(r)}: الاسم «${who.name}» غير مربوط بشخص في Basecamp. اربطه من شاشة «مطابقة الأسماء» في المنصة.`, who.name)
      }
    }

    if (level === 0) {
      mainPosition += 1
      subPosition = 0
      currentMain = { row, title: mainText, held: blocked }
      if (due.ok && due.value === null) result.autoDue.add(row.uid)
    } else {
      subPosition += 1
      if (due.ok && due.value !== null) {
        const prev = latestSubDue.get(currentMain!.row.uid)
        if (prev === undefined || due.value > prev) latestSubDue.set(currentMain!.row.uid, due.value)
      }
      if (!currentMain!.cleared && mainText !== currentMain!.title) result.fixes.push({ row: r, column: columns.main, value: textCell(currentMain!.title) })
      // A subtask under a held to-do waits with it: it has no Basecamp parent to go to.
      if (currentMain!.held && currentMain!.row.bcId === null && !blocked) {
        issue('parent_held', r, true, `الصف ${human(r)}: ينتظر مهمته الرئيسية «${currentMain!.title}» المتوقفة؛ يُرسل حين تُحلّ مشكلتها.`, currentMain!.title)
        blocked = true
      }
    }

    if (blocked) continue
    const ids = who.ok ? who.ids : []
    // A copied row is a new task: it takes nothing hidden from the row it was copied from.
    const carry = identity.known?.carry
    result.tasks.push({
      uid: row.uid,
      sheetId: input.sheetId,
      parentUid: row.parentUid,
      level,
      position: level === 0 ? mainPosition : subPosition,
      title: level === 0 ? mainText : subText,
      assignees: ids.map((id) => ({ kind: 'bc_person', bcPersonId: id, source: 'manual' })),
      dueOn: due.ok ? due.value : null,
      startsOn: level === 0 ? (carry?.startsOn ?? null) : null,
      completed: isDone(cells[columns.status]),
      notesHtml: level === 0 ? (carry?.notesHtml ?? null) : null,
      freeColumnsForDescription: {},
      attachments: [],
      // A to-do with no title in «القسم» takes its subtasks' people (spec §8.1).
      assignMode: level === 0 && ids.length === 0 ? 'auto' : 'manual',
      localChangedAt: input.changedAt,
      bcId: row.bcId,
      deletedRemotely: identity.known?.deletedRemotely ?? false,
    })
  }
  // Option أ: an empty to-do date is the latest of its subtasks' dates.
  for (const task of result.tasks) {
    if (task.level === 0 && result.autoDue.has(task.uid)) task.dueOn = latestSubDue.get(task.uid) ?? null
  }
  return result

  /** The row's identity; `known` is the stored one it keeps, `null` for a new (or copied) row. */
  function identityFor(r: number, level: TaskLevel): { uid: TaskUid; bcId: number | null; blocked: boolean; known: RowIdentity | null } {
    const known = input.identities.get(r)
    if (known !== undefined && !usedUids.has(known.uid)) {
      usedUids.add(known.uid)
      if (known.level !== undefined && known.level !== level) {
        const was = known.level === 0 ? 'مهمة رئيسية' : 'مهمة فرعية'
        issue('level_changed', r, true, `الصف ${human(r)}: كان ${was} ولا يمكن تحويله في Basecamp. أعده كما كان، أو احذفه وأضف صفاً جديداً.`)
        return { uid: known.uid, bcId: known.bcId, blocked: true, known }
      }
      return { uid: known.uid, bcId: known.bcId, blocked: false, known }
    }
    if (known !== undefined) {
      issue('duplicate_identity', r, false, `الصف ${human(r)}: نسخة من صف آخر، فسيُعامل مهمة جديدة.`)
    }
    const uid = input.newUid()
    usedUids.add(uid)
    result.newIdentities.push({ row: r, uid })
    return { uid, bcId: null, blocked: false, known: null }
  }
}

/**
 * Rows deleted from the sheet since the last sync (owner decision 9-ب:
 * deletion is automatic). `known` is every synced task of the tab. A subtask
 * whose to-do is deleted too is left out: it goes to the trash with it.
 * Feed the result to sync-engine `planDeletion`.
 */
export function deletedTasks(
  known: readonly Pick<LocalTask, 'uid' | 'level' | 'parentUid' | 'bcId'>[],
  rows: readonly Pick<TabRow, 'uid'>[],
): { task: Pick<LocalTask, 'uid' | 'level' | 'parentUid'>; bcId: number | null }[] {
  const present = new Set(rows.map((r) => r.uid))
  const gone = known.filter((t) => !present.has(t.uid))
  const goneTodos = new Set(gone.filter((t) => t.level === 0).map((t) => t.uid))
  return gone
    .filter((t) => !(t.level === 1 && t.parentUid !== null && goneTodos.has(t.parentUid)))
    .map((t) => ({ task: { uid: t.uid, level: t.level, parentUid: t.parentUid }, bcId: t.bcId }))
}
