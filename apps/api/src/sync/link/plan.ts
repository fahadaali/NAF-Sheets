// The link wizard's plan (spec §7.3; contract: LinkPlan in
// packages/shared/src/api-integrations.ts): checked, then read against the
// latest snapshot. Pure apart from the inputs; shared by preview and commit so
// both see exactly the same rows, hierarchy and title matches.

import type { ColumnPlan, HierarchyRule, LinkPlan, MappedField, ProjectChoice, SheetPlan } from '@naf-sheets/shared'
import { detectHierarchy, normalizeLabel, textGridFromWorksheet } from '@naf-sheets/gsheets-import'
import type { TextGrid } from '@naf-sheets/gsheets-import'
import { columnIndex, normalizeName, splitAssigneeText } from '@naf-sheets/sheet-model'
import type { InitialLevel, WorkbookSnapshot } from '@naf-sheets/sheet-model'
import { LINK_WARNINGS } from '../messages'
import { SyncFailure } from '../errors'
import type { SheetRow } from '../store'

const FIELDS: ReadonlySet<string> = new Set<MappedField>(['title', 'assignees', 'due_on', 'starts_on', 'completed', 'notes', 'attachments', 'free'])
const MAX_NAME = 200

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function invalid(detail: string): never {
  throw new SyncFailure('invalid_plan', `خطة الربط غير صالحة: ${detail}، فلم يُنفَّذ شيء. راجع خطوات معالج الربط ثم أعد المحاولة.`)
}

/** The request body as a `LinkPlan`, or 400 `invalid_link_plan` saying what is wrong. */
export function parseLinkPlan(body: unknown, sheets: readonly SheetRow[]): LinkPlan {
  if (!isObject(body) || !isObject(body.project) || !Array.isArray(body.sheets)) invalid('يجب أن تحوي «project» و«sheets»')
  const p = body.project
  let project: ProjectChoice
  if (p.mode === 'existing' && positiveInt(p.projectId)) project = { mode: 'existing', projectId: p.projectId }
  else if (p.mode === 'create' && typeof p.name === 'string' && p.name.trim() !== '' && p.name.trim().length <= MAX_NAME) project = { mode: 'create', name: p.name.trim() }
  else if (p.mode === 'none') project = { mode: 'none' }
  else invalid('اختيار المشروع غير مفهوم')

  const known = new Map(sheets.map((s) => [s.id, s]))
  const seen = new Set<string>()
  const lists = new Set<number>()
  const plans: SheetPlan[] = body.sheets.map((raw: unknown) => {
    if (!isObject(raw) || typeof raw.sheetId !== 'string' || !known.has(raw.sheetId)) invalid('إحدى الأوراق غير موجودة في الملف')
    const sheet = known.get(raw.sheetId) as SheetRow
    const name = `الورقة «${sheet.title}»`
    if (seen.has(sheet.id)) invalid(`${name} مكررة في الخطة`)
    seen.add(sheet.id)
    const mode = raw.mode
    if (mode !== 'existing' && mode !== 'new' && mode !== 'local') invalid(`وضع ${name} غير مفهوم`)
    if (mode !== 'local' && project.mode === 'none') invalid(`${name} لا تُزامَن دون مشروع`)
    if (mode === 'existing') {
      if (!positiveInt(raw.todolistId)) invalid(`لم تُحدَّد قائمة ${name}`)
      if (lists.has(raw.todolistId)) invalid(`القائمة نفسها مختارة لأكثر من ورقة`)
      lists.add(raw.todolistId)
    }
    if (!Number.isSafeInteger(raw.headerRow) || (raw.headerRow as number) < 1) invalid(`صف العناوين في ${name} غير صالح`)
    if (!Array.isArray(raw.columns)) invalid(`مطابقة أعمدة ${name} مفقودة`)
    const keys = new Set<string>()
    const singles = new Set<string>()
    const columns: ColumnPlan[] = raw.columns.map((c: unknown) => {
      if (!isObject(c) || typeof c.columnKey !== 'string' || columnIndex(c.columnKey) === null) invalid(`عمود في ${name} غير صالح`)
      if (typeof c.field !== 'string' || !FIELDS.has(c.field)) invalid(`حقل عمود في ${name} غير مفهوم`)
      const key = c.columnKey.trim().toUpperCase()
      if (keys.has(key)) invalid(`العمود ${key} مكرر في ${name}`)
      keys.add(key)
      const field = c.field as MappedField
      if (field !== 'free') {
        if (singles.has(field)) invalid(`حقل واحد مطابق لأكثر من عمود في ${name}`)
        singles.add(field)
      }
      return field === 'free' ? { columnKey: key, field, appendToDescription: c.appendToDescription === true } : { columnKey: key, field }
    })
    if (mode !== 'local' && !singles.has('title')) invalid(`لا يوجد عمود للعنوان في ${name}`)
    const completedValues = Array.isArray(raw.completedValues) ? raw.completedValues.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : []
    const h = raw.hierarchy
    let hierarchy: HierarchyRule
    if (isObject(h) && h.mode === 'numbering' && typeof h.columnKey === 'string' && columnIndex(h.columnKey) !== null) hierarchy = { mode: 'numbering', columnKey: h.columnKey.trim().toUpperCase() }
    else if (isObject(h) && h.mode === 'indent') hierarchy = { mode: 'indent' }
    else if (h === undefined || (isObject(h) && h.mode === 'flat')) hierarchy = { mode: 'flat' }
    else invalid(`طريقة اكتشاف المهام الفرعية في ${name} غير مفهومة`)
    const existingTasks = raw.existingTasks === 'match_by_title' ? 'match_by_title' : 'create_all'
    const assigneeMatches: Record<string, number | null> = {}
    if (raw.assigneeMatches !== undefined) {
      if (!isObject(raw.assigneeMatches)) invalid(`مطابقة المسؤولين في ${name} غير صالحة`)
      for (const [text, id] of Object.entries(raw.assigneeMatches)) {
        if (id !== null && !positiveInt(id)) invalid(`مطابقة المسؤول «${text}» غير صالحة`)
        assigneeMatches[text] = id
      }
    }
    const plan: SheetPlan = { sheetId: sheet.id, mode, headerRow: raw.headerRow as number, columns, completedValues, hierarchy, existingTasks, assigneeMatches }
    if (mode === 'existing') plan.todolistId = raw.todolistId as number
    return plan
  })
  return { project, sheets: plans }
}

export interface AnalyzedRow {
  /** 0-based. */
  row: number
  title: string
  level: 0 | 1
  parentRow: number | null
}

export interface SheetAnalysis {
  sheet: SheetRow
  plan: SheetPlan
  rows: AnalyzedRow[]
  /** For `ensureSystemColumns` when the plan is not flat. */
  levels: InitialLevel[] | undefined
  warnings: string[]
  /** Distinct texts of the assignee cells, as written. */
  assigneeTexts: string[]
}

function cell(grid: TextGrid, row: number, column: number): string {
  return grid[row]?.[column] ?? ''
}

/** A synced sheet of the plan, read from the snapshot: its task rows, their levels and the assignee texts. */
export function analyzeSheet(snapshot: WorkbookSnapshot, sheet: SheetRow, plan: SheetPlan): SheetAnalysis {
  const worksheet = snapshot.sheets[sheet.univer_sheet_id]
  if (!worksheet) invalid(`الورقة «${sheet.title}» غير موجودة في محتوى الملف`)
  const grid = textGridFromWorksheet(worksheet)
  const header = plan.headerRow - 1
  const titleKey = plan.columns.find((c) => c.field === 'title')?.columnKey ?? ''
  const titleColumn = columnIndex(titleKey) as number
  const warnings: string[] = []
  const h = plan.hierarchy
  const detection =
    h.mode === 'flat'
      ? null
      : detectHierarchy(grid, { headerRow: header, titleColumn, numberingColumn: h.mode === 'numbering' ? (columnIndex(h.columnKey) as number) : null })
  const rows: AnalyzedRow[] = []
  if (detection === null) {
    for (let r = header + 1; r < grid.length; r++) {
      const title = cell(grid, r, titleColumn).trim()
      if (title !== '') rows.push({ row: r, title, level: 0, parentRow: null })
    }
  } else {
    for (const w of detection.warnings) warnings.push(w.kind === 'too_deep' ? LINK_WARNINGS.tooDeep(w.row + 1) : LINK_WARNINGS.orphan(w.row + 1))
    let lastTodo: number | null = null
    for (const d of detection.rows) {
      const title = cell(grid, d.row, titleColumn).trim()
      // A subtask sits right under its to-do (§8); anything else is linked as a to-do.
      if (d.level === 1 && d.parentRow !== lastTodo) {
        warnings.push(LINK_WARNINGS.notUnderParent(d.row + 1))
        rows.push({ row: d.row, title, level: 0, parentRow: null })
        lastTodo = d.row
        continue
      }
      rows.push({ row: d.row, title, level: d.level, parentRow: d.level === 1 ? d.parentRow : null })
      if (d.level === 0) lastTodo = d.row
    }
  }
  const assigneeKey = plan.columns.find((c) => c.field === 'assignees')?.columnKey
  const texts = new Map<string, string>()
  if (assigneeKey !== undefined) {
    const column = columnIndex(assigneeKey) as number
    for (const r of rows) for (const name of splitAssigneeText(cell(grid, r.row, column))) if (!texts.has(normalizeName(name))) texts.set(normalizeName(name), name)
  }
  const completedKey = plan.columns.find((c) => c.field === 'completed')?.columnKey
  if (completedKey !== undefined && (plan.completedValues ?? []).length === 0) {
    const column = columnIndex(completedKey) as number
    const textual = rows.some((r) => {
      const v = cell(grid, r.row, column).trim()
      return v !== '' && v !== 'TRUE' && v !== 'FALSE' && v !== '1' && v !== '0'
    })
    if (textual) warnings.push(LINK_WARNINGS.noStatusValues)
  }
  return {
    sheet,
    plan,
    rows,
    levels: detection === null ? undefined : rows.map((r) => ({ row: r.row, level: r.level, parentRow: r.parentRow })),
    warnings,
    assigneeTexts: [...texts.values()],
  }
}

/** Title matches (§7.3 step 8): to-dos only, both titles unique on their side. */
export function matchByTitle(
  analysis: SheetAnalysis,
  todos: ReadonlyArray<{ id: number; content: string }>,
): { matches: Array<{ row: number; title: string; todoId: number; todoTitle: string }>; warnings: string[] } {
  const rowsByTitle = new Map<string, AnalyzedRow[]>()
  for (const r of analysis.rows) if (r.level === 0) rowsByTitle.set(normalizeName(r.title), [...(rowsByTitle.get(normalizeName(r.title)) ?? []), r])
  const todosByTitle = new Map<string, Array<{ id: number; content: string }>>()
  for (const t of todos) todosByTitle.set(normalizeName(t.content), [...(todosByTitle.get(normalizeName(t.content)) ?? []), t])
  const matches: Array<{ row: number; title: string; todoId: number; todoTitle: string }> = []
  const warnings: string[] = []
  for (const [key, rows] of rowsByTitle) {
    const candidates = todosByTitle.get(key) ?? []
    if (candidates.length === 0) continue
    const first = rows[0] as AnalyzedRow
    if (rows.length > 1 || candidates.length > 1) {
      warnings.push(LINK_WARNINGS.duplicateTitle(first.title))
      continue
    }
    const todo = candidates[0] as { id: number; content: string }
    matches.push({ row: first.row, title: first.title, todoId: todo.id, todoTitle: todo.content })
  }
  matches.sort((a, b) => a.row - b.row)
  return { matches, warnings }
}

// ---------------------------------------------------------------------------
// Assignee texts → Basecamp people (§7.3 step 7)
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0] as number
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const above = prev[j] as number
      prev[j] = Math.min(above + 1, (prev[j - 1] as number) + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
      diagonal = above
    }
  }
  return prev[b.length] as number
}

/** 0..1, on the wizard's folded labels (alef forms, diacritics); a name inside the other scores at least 0.8. */
export function nameSimilarity(a: string, b: string): number {
  const x = normalizeLabel(a)
  const y = normalizeLabel(b)
  if (x === '' || y === '') return 0
  if (x === y) return 1
  const score = 1 - levenshtein(x, y) / Math.max(x.length, y.length)
  return x.includes(y) || y.includes(x) ? Math.max(score, 0.8) : score
}

/** OPEN: threshold and number of candidates are not in the spec (S11). */
export const CANDIDATE_THRESHOLD = 0.5
const MAX_CANDIDATES = 5

export function unmatchedAssignees(
  texts: readonly string[],
  plan: SheetPlan,
  people: ReadonlyArray<{ id: number; name: string }>,
  externals: ReadonlyArray<{ id: string; name: string }>,
): Array<{ text: string; candidates: Array<{ bcPersonId: number; name: string; score: number }> }> {
  const decided = new Set(Object.keys(plan.assigneeMatches ?? {}).map(normalizeName))
  const out: Array<{ text: string; candidates: Array<{ bcPersonId: number; name: string; score: number }> }> = []
  for (const text of texts) {
    const key = normalizeName(text)
    if (decided.has(key)) continue
    const exact = people.filter((p) => normalizeName(p.name) === key).length + externals.filter((e) => normalizeName(e.name) === key).length
    if (exact === 1) continue
    const candidates = people
      .map((p) => ({ bcPersonId: p.id, name: p.name, score: Math.round(nameSimilarity(text, p.name) * 100) / 100 }))
      .filter((c) => c.score >= CANDIDATE_THRESHOLD)
      .sort((a, b) => b.score - a.score || a.bcPersonId - b.bcPersonId)
      .slice(0, MAX_CANDIDATES)
    out.push({ text, candidates })
  }
  return out
}
