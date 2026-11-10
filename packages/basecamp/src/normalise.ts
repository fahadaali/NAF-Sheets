// Raw Basecamp JSON → shared `RemoteTodo` / `RemoteSubtask` (spec Appendix A,
// packages/shared/src/domain.ts).
//
// The input is validated, not trusted: a field the sync engine depends on that
// is missing or of the wrong type throws `NormaliseError` instead of being
// silently defaulted, so a wrong value can never reach a three-way diff.

import type { IsoDate, RecordingStatus, RemoteSubtask, RemoteTodo } from '@naf-sheets/shared'

export class NormaliseError extends Error {
  override readonly name = 'NormaliseError'
  readonly field: string
  constructor(kind: string, field: string, problem: string) {
    super(`Cannot normalise Basecamp ${kind}: ${field} ${problem}`)
    this.field = field
  }
}

const RECORDING_STATUSES: readonly RecordingStatus[] = ['active', 'archived', 'trashed']
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

class Reader {
  constructor(
    private readonly kind: string,
    private readonly obj: Obj,
  ) {}

  fail(field: string, problem: string): never {
    throw new NormaliseError(this.kind, field, problem)
  }

  id(field: string): number {
    const v = this.obj[field]
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) this.fail(field, 'must be a positive integer')
    return v
  }

  string(field: string): string {
    const v = this.obj[field]
    if (typeof v !== 'string') this.fail(field, 'must be a string')
    return v
  }

  boolean(field: string): boolean {
    const v = this.obj[field]
    if (typeof v !== 'boolean') this.fail(field, 'must be a boolean')
    return v
  }

  count(field: string): number {
    const v = this.obj[field]
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) this.fail(field, 'must be a non-negative integer')
    return v
  }

  /** `YYYY-MM-DD` or null. The key must be present (null is a value; absence is not). */
  date(field: string): IsoDate | null {
    if (!(field in this.obj)) this.fail(field, 'is missing')
    const v = this.obj[field]
    if (v === null) return null
    if (typeof v !== 'string' || !ISO_DATE.test(v)) this.fail(field, 'must be YYYY-MM-DD or null')
    return v
  }

  /**
   * 1-based position, or `null` when Basecamp did not send one: the documented
   * `GET /todos/{id}.json` example has no `position` key (todos.md "Get a
   * to-do"), and the official SDK schema marks it optional on to-dos and
   * subtasks. The sync engine treats `null` as unknown.
   */
  position(): number | null {
    const v = this.obj['position']
    if (v === undefined || v === null) return null
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) this.fail('position', 'must be an integer >= 1')
    return v
  }

  status(): RecordingStatus {
    const v = this.obj['status']
    if (typeof v !== 'string' || !(RECORDING_STATUSES as readonly string[]).includes(v)) {
      this.fail('status', 'must be active, archived or trashed')
    }
    return v as RecordingStatus
  }

  type(expected: string): void {
    if (this.obj['type'] !== expected) this.fail('type', `must be ${JSON.stringify(expected)}`)
  }

  /** `id` of a nested reference such as `parent` or `bucket`, optionally checking its `type`. */
  refId(field: string, expectedType?: string): number {
    const ref = this.obj[field]
    if (!isObj(ref)) this.fail(field, 'must be an object')
    if (expectedType !== undefined && ref['type'] !== expectedType) {
      this.fail(`${field}.type`, `must be ${JSON.stringify(expectedType)} (got ${JSON.stringify(ref['type'])})`)
    }
    const id = ref['id']
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) this.fail(`${field}.id`, 'must be a positive integer')
    return id
  }

  /** `[].id` of an array of people (`assignees`, `completion_subscribers`). */
  personIds(field: string): number[] {
    const list = this.obj[field]
    if (!Array.isArray(list)) this.fail(field, 'must be an array')
    return list.map((p, i) => {
      const id = isObj(p) ? p['id'] : undefined
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) this.fail(`${field}[${i}].id`, 'must be a positive integer')
      return id
    })
  }

  /** `creator.id`, or null when there is no usable creator. */
  creatorId(): number | null {
    const c = this.obj['creator']
    if (!isObj(c)) return null
    const id = c['id']
    return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null
  }
}

/** A to-do from `GET /todolists/{id}/todos.json`, `GET /todos/{id}.json`, or a create/update response. */
export function normaliseTodo(raw: unknown): RemoteTodo {
  if (!isObj(raw)) throw new NormaliseError('to-do', '(root)', 'must be an object')
  const r = new Reader('to-do', raw)
  r.type('Todo')
  return {
    type: 'todo',
    id: r.id('id'),
    // OPEN: a loose to-do (parent = Todoset) has no sheet; rejected, not mapped.
    // A to-do inside a list group has the group (also type Todolist) as parent,
    // so listId is then the group's id. See OPEN_QUESTIONS.md.
    listId: r.refId('parent', 'Todolist'),
    bucketId: r.refId('bucket'),
    position: r.position(),
    content: r.string('content'),
    descriptionHtml: r.string('description'),
    assigneeIds: r.personIds('assignees'),
    completionSubscriberIds: r.personIds('completion_subscribers'),
    dueOn: r.date('due_on'),
    startsOn: r.date('starts_on'),
    completed: r.boolean('completed'),
    status: r.status(),
    updatedAt: r.string('updated_at'),
    subtasksCount: r.count('subtasks_count'),
    subtasksCompletedCount: r.count('subtasks_completed_count'),
    creatorId: r.creatorId(),
  }
}

/** A subtask (`Kanban::Step`) from the subtask endpoints. */
export function normaliseSubtask(raw: unknown): RemoteSubtask {
  if (!isObj(raw)) throw new NormaliseError('subtask', '(root)', 'must be an object')
  const r = new Reader('subtask', raw)
  r.type('Kanban::Step')
  return {
    type: 'subtask',
    id: r.id('id'),
    // A card's steps share this wire type; only steps of a to-do belong to a sheet.
    todoId: r.refId('parent', 'Todo'),
    position: r.position(),
    title: r.string('title'),
    assigneeIds: r.personIds('assignees'),
    dueOn: r.date('due_on'),
    completed: r.boolean('completed'),
    updatedAt: r.string('updated_at'),
  }
}
