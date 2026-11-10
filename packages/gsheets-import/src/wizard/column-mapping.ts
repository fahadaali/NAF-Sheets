// Column-mapping suggestions (spec §7.3 step 4). The synonyms are exactly the
// ones the spec lists; everything else is suggested as a free column, which
// the user may attach to the Basecamp description.

import { normalizeLabel } from './normalize'

/** Fields a column can map to. Mirrors `MappedField` in @naf-sheets/shared minus 'free'. */
export type WizardField = 'title' | 'assignees' | 'due_on' | 'starts_on' | 'completed' | 'notes' | 'attachments'
/** Mirrors `MappedField` in @naf-sheets/shared. */
export type ColumnFieldSuggestion = WizardField | 'free'

/** Spec §7.3 step 4, verbatim. */
export const COLUMN_SYNONYMS: Readonly<Record<WizardField, readonly string[]>> = {
  title: ['المهمة', 'العنوان', 'البند', 'النشاط', 'Task'],
  assignees: ['المسؤول', 'المكلف', 'المنفذ', 'Owner', 'Assignee'],
  due_on: ['تاريخ الاستحقاق', 'الموعد النهائي', 'تاريخ الإنجاز', 'Due'],
  starts_on: ['تاريخ البدء', 'Start'],
  completed: ['الحالة', 'منجز', 'تم', 'Done', 'Status'],
  notes: ['ملاحظات', 'الوصف', 'التفاصيل'],
  attachments: ['المرفقات', 'الملفات'],
}

const FIELDS = Object.keys(COLUMN_SYNONYMS) as WizardField[]

export interface HeaderMatch {
  field: WizardField
  synonym: string
  /** exact: the whole header is the synonym; partial: the synonym appears as whole words in it. */
  match: 'exact' | 'partial'
}

/** Every field whose synonym matches `header`, exact matches first. */
export function matchHeader(header: string): HeaderMatch[] {
  const h = normalizeLabel(header)
  if (h === '') return []
  const exact: HeaderMatch[] = []
  const partial: HeaderMatch[] = []
  for (const field of FIELDS) {
    for (const synonym of COLUMN_SYNONYMS[field]) {
      const s = normalizeLabel(synonym)
      if (h === s) {
        exact.push({ field, synonym, match: 'exact' })
        break
      }
      if (` ${h} `.includes(` ${s} `)) {
        partial.push({ field, synonym, match: 'partial' })
        break
      }
    }
  }
  return [...exact, ...partial]
}

export interface ColumnMappingSuggestion {
  column: number
  header: string
  field: ColumnFieldSuggestion
  match: 'exact' | 'partial' | 'none'
  synonym: string | null
  /** Free columns only: append the value to the Basecamp description. Off until the user turns it on. */
  appendToDescription: boolean
  /** Fields that also matched but were not chosen (taken by another column, or ambiguous). */
  alternatives: WizardField[]
}

/**
 * One suggestion per header. Each field goes to at most one column: exact
 * matches win over partial ones, then the leftmost column. A header matching
 * several fields only partially (e.g. "Task owner") stays free.
 */
export function suggestColumnMapping(headers: readonly string[]): ColumnMappingSuggestion[] {
  const out: ColumnMappingSuggestion[] = headers.map((header, column) => ({
    column,
    header,
    field: 'free',
    match: 'none',
    synonym: null,
    appendToDescription: false,
    alternatives: [],
  }))
  const matches = headers.map((h) => matchHeader(h))
  const taken = new Set<WizardField>()
  for (const pass of ['exact', 'partial'] as const) {
    matches.forEach((list, column) => {
      const suggestion = out[column] as ColumnMappingSuggestion
      if (suggestion.field !== 'free') return
      const hasExact = list.some((m) => m.match === 'exact')
      // Partial matches count only for headers without an exact one, and only when unambiguous.
      if (pass === 'partial' && hasExact) return
      const candidates = list.filter((m) => m.match === pass)
      if (candidates.length === 0) return
      if (pass === 'partial' && candidates.length > 1) {
        suggestion.alternatives = candidates.map((m) => m.field)
        return
      }
      const chosen = candidates.find((m) => !taken.has(m.field))
      if (!chosen) {
        suggestion.alternatives = candidates.map((m) => m.field)
        return
      }
      taken.add(chosen.field)
      suggestion.field = chosen.field
      suggestion.match = chosen.match
      suggestion.synonym = chosen.synonym
      suggestion.alternatives = list.filter((m) => m.field !== chosen.field).map((m) => m.field)
    })
  }
  return out
}
