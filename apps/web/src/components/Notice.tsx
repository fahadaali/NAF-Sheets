import { CircleExclamationPoint, Info, TriangleExclamationPoint } from 'lucide-react'
import type { ReactNode } from 'react'

type Tone = 'danger' | 'warning' | 'info'

const ICONS = { danger: CircleExclamationPoint, warning: TriangleExclamationPoint, info: Info } as const

/**
 * An inline message with an icon and a label (never colour alone). Errors and
 * warnings are announced (`role="alert"`), information is polite (`status`).
 */
export function Notice({ tone, title, children, actions, testId }: { tone: Tone; title?: string; children?: ReactNode; actions?: ReactNode; testId?: string }) {
  const Icon = ICONS[tone]
  return (
    <div className={`notice notice--${tone}`} role={tone === 'info' ? 'status' : 'alert'} data-testid={testId}>
      <Icon className="icon" aria-hidden="true" />
      <div className="notice__body">
        {title ? <p className="notice__title">{title}</p> : null}
        {children}
        {actions ? <div className="notice__actions">{actions}</div> : null}
      </div>
    </div>
  )
}
