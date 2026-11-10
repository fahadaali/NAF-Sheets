// The frame of an admin-only screen (spec §12.1 item 8): app bar, title, and
// for anyone but a platform admin an explanation instead of the content. No
// request is made for them; the API refuses them on its own anyway.

import type { ReactNode } from 'react'
import { LoaderCircle, ShieldX } from 'lucide-react'
import type { CurrentUser } from '@naf-sheets/shared'
import { AppBar } from './AppBar'
import { Link } from '../lib/router'
import { pathFor } from '../lib/routes'
import { useDocumentTitle } from '../lib/use-document-title'
import { t } from '../strings'

export function AdminPage({
  user,
  userSettled,
  title,
  screen,
  children,
}: {
  user: CurrentUser | null
  userSettled: boolean
  title: string
  /** `data-screen` of the page, for tests. */
  screen: string
  children: ReactNode
}) {
  useDocumentTitle(title)
  return (
    <>
      <a className="skip-link" href="#main">
        {t.skipToContent}
      </a>
      <AppBar user={user} />
      <main id="main" className="page" data-screen={screen}>
        <div className="page-head">
          <h1>{title}</h1>
        </div>
        {!userSettled ? (
          <div className="panel panel--plain" role="status">
            <LoaderCircle className="panel__icon spin" aria-hidden="true" />
            <p>{t.adminOnly.loading}</p>
          </div>
        ) : user?.role === 'admin' ? (
          children
        ) : (
          <section className="panel" data-testid="admin-only">
            <ShieldX className="panel__icon" aria-hidden="true" />
            <h2>{t.adminOnly.title}</h2>
            <p>{t.adminOnly.body}</p>
            <Link className="button" href={pathFor({ name: 'settings' })}>
              {t.settings.title}
            </Link>
          </section>
        )}
      </main>
    </>
  )
}
