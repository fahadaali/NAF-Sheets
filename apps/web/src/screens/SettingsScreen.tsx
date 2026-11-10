// The user's settings: their own Basecamp account (spec §3, «اربط حسابك في
// Basecamp»), and for platform admins the entries of §12.1 item 8 that exist
// so far: people matching (§3), sync health (§9.4), templates (§7.1) and the
// internal API's service tokens (§13).

import type { ReactNode } from 'react'
import { Activity, KeyRound, LayoutTemplate, Users } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { CurrentUser } from '@naf-sheets/shared'
import { AppBar } from '../components/AppBar'
import { BasecampAccountCard } from '../components/BasecampLink'
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
          <BasecampAccountCard />
          {/* Hidden for everyone but platform admins; the API refuses the rest anyway. */}
          {user?.role === 'admin' ? (
            <section className="card" aria-labelledby="admin-heading" data-testid="admin-section">
              <h2 id="admin-heading">{t.settings.adminSection}</h2>
              <AdminEntry Icon={Users} title={t.settings.peopleMatchesTitle} body={t.settings.peopleMatchesBody}>
                <Link className="button button--small" href={pathFor({ name: 'peopleMatches' })}>
                  {t.settings.peopleMatchesOpen}
                </Link>
              </AdminEntry>
              <AdminEntry Icon={Activity} title={t.settings.syncHealthTitle} body={t.settings.syncHealthBody}>
                <Link className="button button--small" href={pathFor({ name: 'syncHealth' })} data-testid="open-sync-health">
                  {t.settings.syncHealthOpen}
                </Link>
              </AdminEntry>
              <AdminEntry Icon={LayoutTemplate} title={t.settings.templatesTitle} body={t.settings.templatesBody}>
                <Link className="button button--small" href={pathFor({ name: 'templates' })} data-testid="open-templates">
                  {t.settings.templatesOpen}
                </Link>
              </AdminEntry>
              <AdminEntry Icon={KeyRound} title={t.settings.apiTokensTitle} body={t.settings.apiTokensBody}>
                <Link className="button button--small" href={pathFor({ name: 'apiTokens' })} data-testid="open-api-tokens">
                  {t.settings.apiTokensOpen}
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
