// Status column values (spec §7.3 step 6): when the status column holds text
// ("منجز / قيد التنفيذ / متأخر") the user picks the value that means
// "completed"; the other values stay in the platform. A checkbox column
// (TRUE/FALSE) needs no choice.
//
// Suggested completed values: the completed-column words of spec §7.3 step 4
// that name a state (منجز، تم، Done) — not the header words الحالة / Status.

import { normalizeLabel } from './normalize'

export const COMPLETED_VALUE_SUGGESTIONS: readonly string[] = ['منجز', 'تم', 'Done']

export interface StatusValueCount {
  value: string
  count: number
}

export interface StatusColumnAnalysis {
  kind: 'empty' | 'boolean' | 'text'
  /** Distinct trimmed values in order of first appearance. */
  distinct: StatusValueCount[]
  /** Values to pre-select as "completed"; the user confirms. */
  suggestedCompleted: string[]
}

export function analyzeStatusColumn(values: readonly string[]): StatusColumnAnalysis {
  const counts = new Map<string, number>()
  for (const raw of values) {
    const v = raw.trim()
    if (v === '') continue
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  const distinct = [...counts].map(([value, count]) => ({ value, count }))
  if (distinct.length === 0) return { kind: 'empty', distinct, suggestedCompleted: [] }
  const isBoolean = distinct.every((d) => ['true', 'false'].includes(normalizeLabel(d.value)))
  if (isBoolean) {
    return { kind: 'boolean', distinct, suggestedCompleted: distinct.filter((d) => normalizeLabel(d.value) === 'true').map((d) => d.value) }
  }
  const wanted = new Set(COMPLETED_VALUE_SUGGESTIONS.map(normalizeLabel))
  return { kind: 'text', distinct, suggestedCompleted: distinct.filter((d) => wanted.has(normalizeLabel(d.value))).map((d) => d.value) }
}

/** Whether a cell value means "completed", given the values the user chose. */
export function isCompletedValue(value: string, completedValues: readonly string[]): boolean {
  const v = normalizeLabel(value)
  if (v === '') return false
  return completedValues.some((c) => normalizeLabel(c) === v)
}
