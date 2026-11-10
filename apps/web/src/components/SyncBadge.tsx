import { CircleCheck, CircleExclamationPoint, Clock, Link2Off, TriangleExclamationPoint } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { WorkbookSummary } from '@naf-sheets/shared'
import { t } from '../strings'

type SyncState = WorkbookSummary['syncState']

// Meaning is never carried by colour alone: every state has an icon and a label.
const LOOK: Record<SyncState, { label: string; Icon: LucideIcon; tone: string }> = {
  synced: { label: t.sync.synced, Icon: CircleCheck, tone: 'success' },
  pending: { label: t.sync.pending, Icon: Clock, tone: 'info' },
  error: { label: t.sync.error, Icon: TriangleExclamationPoint, tone: 'danger' },
  conflict: { label: t.sync.conflict, Icon: CircleExclamationPoint, tone: 'warning' },
  unlinked: { label: t.sync.unlinked, Icon: Link2Off, tone: 'neutral' },
}

export function SyncBadge({ state }: { state: SyncState }) {
  const look = LOOK[state] ?? LOOK.unlinked
  const { Icon } = look
  return (
    <span className={`badge badge--${look.tone}`} data-sync-state={state}>
      <Icon className="icon" aria-hidden="true" />
      {look.label}
    </span>
  )
}
