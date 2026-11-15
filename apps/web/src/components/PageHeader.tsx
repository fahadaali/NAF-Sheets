// The head of a page: a way back to where it was opened from, the title,
// an optional line under it, and the page's own actions.

import type { ReactNode } from 'react'
import { ArrowRight } from 'lucide-react'
import { Link } from '../lib/router'
import { t } from '../strings'

export function PageHeader({ title, back, subtitle, actions }: { title: ReactNode; back?: { href: string; label: string }; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      {back ? (
        <Link href={back.href} className="page-header__back" data-testid="back-link">
          {/* RTL: «back» points to the start, which is the right. */}
          <ArrowRight className="icon" aria-hidden="true" />
          <span>
            {t.back} {back.label}
          </span>
        </Link>
      ) : null}
      <div className="page-header__row">
        <div className="page-header__titles">
          <h1>{title}</h1>
          {subtitle ? <p className="page-header__subtitle">{subtitle}</p> : null}
        </div>
        {actions ? <div className="page-header__actions">{actions}</div> : null}
      </div>
    </div>
  )
}
