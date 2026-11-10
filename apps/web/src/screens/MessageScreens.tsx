import { CircleExclamationPoint, SearchX } from 'lucide-react'
import type { CurrentUser } from '@naf-sheets/shared'
import { AppBar } from '../components/AppBar'
import { Link } from '../lib/router'
import { useDocumentTitle } from '../lib/use-document-title'
import { t } from '../strings'

/**
 * naf-auth sends document navigations it refuses to `/denied?r=<reason>`; the
 * reason is a code, translated here (naf-auth README, «صفحة /denied»).
 * OPEN: the wording of each reason needs approval (OPEN_QUESTIONS.md #7).
 */
export function DeniedScreen({ reason }: { reason: string }) {
  useDocumentTitle(t.denied.title)
  return (
    <>
      <AppBar user={null} />
      <main id="main" className="page" data-screen="denied">
        <section className="panel">
          <CircleExclamationPoint className="panel__icon" aria-hidden="true" />
          <h1>{t.denied.title}</h1>
          <p>{t.denied.reasons[reason] ?? t.denied.generic}</p>
          <a className="button" href="/">
            {t.denied.home}
          </a>
        </section>
      </main>
    </>
  )
}

export function NotFoundScreen({ user }: { user: CurrentUser | null }) {
  useDocumentTitle(t.notFound.title)
  return (
    <>
      <AppBar user={user} />
      <main id="main" className="page" data-screen="not-found">
        <section className="panel">
          <SearchX className="panel__icon" aria-hidden="true" />
          <h1>{t.notFound.title}</h1>
          <p>{t.notFound.body}</p>
          <Link className="button button--primary" href="/">
            {t.notFound.home}
          </Link>
        </section>
      </main>
    </>
  )
}
