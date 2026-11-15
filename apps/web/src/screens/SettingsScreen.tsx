// Settings: for platform admins, the platform's members «أعضاء المنصة» (§3),
// the names directory of the station «مطابقة الأسماء», and the palette «المظهر».
// The Basecamp sync account is on the links page (docs/station-plan.md §5).

import type { ReactNode } from 'react'
import { Palette, UserCog, Users } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { CurrentUser } from '@naf-sheets/shared'
import { AppBar } from '../components/AppBar'
import { Link } from '../lib/router'
import { pathFor } from '../lib/routes'
import { useDocumentTitle } from '../lib/use-document-title'
import { t } from '../strings'

export function SettingsScreen({ user }: { user: CurrentUser | null }) {
  useDocumentTitle(t.settings.title)
  return (
    <>
      <a className="skip-link" href="#main">
        {t.skipToContent}
      </a>
      <AppBar user={user} />
      <main id="main" className="page page--narrow" data-screen="settings">
        <div className="page-head">
          <h1>{t.settings.title}</h1>
        </div>
        <div className="stack">
          {user && user.role !== 'admin' ? <p className="muted">{t.adminOnly.body}</p> : null}
          {/* Hidden for everyone but platform admins; the API refuses the rest anyway. */}
          {user?.role === 'admin' ? (
            <section className="card" aria-labelledby="admin-heading" data-testid="admin-section">
              <h2 id="admin-heading">{t.settings.adminSection}</h2>
              <AdminEntry Icon={UserCog} title={t.settings.membersTitle} body={t.settings.membersBody}>
                <Link className="button button--small" href={pathFor({ name: 'members' })} data-testid="open-members">
                  {t.settings.membersOpen}
                </Link>
              </AdminEntry>
              <AdminEntry Icon={Users} title="مطابقة الأسماء" body="ربط الأسماء المكتوبة في تبويبات المسميات بأشخاص Basecamp، مرة واحدة لكل الروابط.">
                <Link className="button button--small" href={pathFor({ name: 'stationNames' })} data-testid="open-names">
                  فتح
                </Link>
              </AdminEntry>
              <AdminEntry Icon={Palette} title={t.appearance.settingsTitle} body={t.appearance.settingsBody}>
                <Link className="button button--small" href={pathFor({ name: 'appearance' })} data-testid="open-appearance">
                  {t.appearance.settingsOpen}
                </Link>
              </AdminEntry>
            </section>
          ) : null}
        </div>
      </main>
    </>
  )
}

function AdminEntry({ Icon, title, body, children }: { Icon: LucideIcon; title: string; body: string; children: ReactNode }) {
  return (
    <>
      <div className="card__row">
        <Icon className="icon" aria-hidden="true" />
        <div>
          <h3>{title}</h3>
          <p className="muted">{body}</p>
        </div>
      </div>
      <div className="card__actions">{children}</div>
    </>
  )
}
