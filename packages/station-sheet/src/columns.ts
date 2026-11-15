// The fixed columns of a linked tab (docs/station-plan.md §3, §11-ج).
// Columns are found by their header text in the first row, never by position:
// tabs place «الاسم» differently, and some carry extra columns («التقدم»).

import { cellText, type CellValue } from './cells'

export const FIXED_HEADERS = {
  /** To-do title; repeated on each of its subtask rows. */
  main: 'المهمة الرئيسية',
  /** Subtask title. */
  sub: 'المهمة',
  /** Job title, resolved to people through «المسميات». */
  role: 'القسم',
  /** لم تبدأ / جارية / منجزة / متوقفة. */
  status: 'الحالة',
  /** Due date. */
  due: 'الموعد',
} as const

export type FixedColumn = keyof typeof FIXED_HEADERS

/** 0-based column index of each fixed column. */
export type TabColumns = Record<FixedColumn, number>

export type ColumnsResult =
  | { ok: true; columns: TabColumns }
  | { ok: false; code: 'missing' | 'duplicated'; headers: string[]; message: string }

export function findColumns(headerRow: readonly CellValue[]): ColumnsResult {
  const found = new Map<FixedColumn, number[]>()
  const wanted = Object.entries(FIXED_HEADERS) as [FixedColumn, string][]
  headerRow.forEach((value, index) => {
    const text = cellText(value)
    for (const [key, header] of wanted) {
      if (text === header) found.set(key, [...(found.get(key) ?? []), index])
    }
  })
  const missing = wanted.filter(([key]) => !found.has(key)).map(([, header]) => header)
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'missing',
      headers: missing,
      message: `لا يمكن ربط هذا التبويب: لا يوجد في صفه الأول ${list(missing)}. أضف العمود بهذا العنوان حرفياً ثم أعد المحاولة.`,
    }
  }
  const duplicated = wanted.filter(([key]) => (found.get(key)?.length ?? 0) > 1).map(([, header]) => header)
  if (duplicated.length > 0) {
    return {
      ok: false,
      code: 'duplicated',
      headers: duplicated,
      message: `لا يمكن ربط هذا التبويب: العنوان ${list(duplicated)} مكرر في الصف الأول. اترك عموداً واحداً بهذا العنوان ثم أعد المحاولة.`,
    }
  }
  const columns = Object.fromEntries(wanted.map(([key]) => [key, found.get(key)![0]])) as TabColumns
  return { ok: true, columns }
}

function list(headers: string[]): string {
  return headers.map((h) => `«${h}»`).join(' و')
}
