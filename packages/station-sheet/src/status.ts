// «الحالة» ↔ Basecamp completion (owner decision 3, 2026-11-15).
// Basecamp knows done / not done only; «جارية» and «متوقفة» live in the sheet.

import { cellText, type CellValue } from './cells'

export const STATUS = {
  notStarted: 'لم تبدأ',
  inProgress: 'جارية',
  done: 'منجزة',
  paused: 'متوقفة',
} as const

export function isDone(status: CellValue): boolean {
  return cellText(status) === STATUS.done
}

/**
 * The status to write after Basecamp changed completion, or `null` when the
 * cell already agrees. Un-completing a done task goes back to «جارية».
 */
export function statusAfterRemoteCompletion(current: CellValue, completed: boolean): string | null {
  if (completed) return isDone(current) ? null : STATUS.done
  return isDone(current) ? STATUS.inProgress : null
}
