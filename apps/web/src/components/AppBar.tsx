import { FileSpreadsheet } from 'lucide-react'
import type { CurrentUser } from '@naf-sheets/shared'
import { Link } from '../lib/router'
import { t } from '../strings'

export function AppBar({ user }: { user: CurrentUser | null }) {
  const who = user?.name || user?.email
  return (
    <header className="app-bar">
      <Link href="/" className="app-bar__brand">
        <FileSpreadsheet className="icon" aria-hidden="true" />
        <span>{t.appName}</span>
      </Link>
      {who ? (
        <span className="app-bar__user">
          <span className="sr-only">{t.signedInAs} </span>
          <bdi>{who}</bdi>
        </span>
      ) : null}
    </header>
  )
}
