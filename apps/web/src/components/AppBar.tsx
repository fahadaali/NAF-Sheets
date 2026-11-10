import { FileSpreadsheet, Settings } from 'lucide-react'
import type { CurrentUser } from '@naf-sheets/shared'
import { Link } from '../lib/router'
import { pathFor } from '../lib/routes'
import { t } from '../strings'

export function AppBar({ user, showSettings = true }: { user: CurrentUser | null; showSettings?: boolean }) {
  const who = user?.name || user?.email
  return (
    <header className="app-bar">
      <Link href="/" className="app-bar__brand">
        <FileSpreadsheet className="icon" aria-hidden="true" />
        <span>{t.appName}</span>
      </Link>
      <div className="app-bar__end">
        {who ? (
          <span className="app-bar__user">
            <span className="sr-only">{t.signedInAs} </span>
            <bdi>{who}</bdi>
          </span>
        ) : null}
        {showSettings ? (
          <Link href={pathFor({ name: 'settings' })} className="app-bar__link" data-testid="settings-link">
            <Settings className="icon" aria-hidden="true" />
            <span>{t.settingsLink}</span>
          </Link>
        ) : null}
      </div>
    </header>
  )
}
