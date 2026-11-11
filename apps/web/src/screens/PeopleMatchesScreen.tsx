// Admin: naf-id members ↔ Basecamp people (spec §3: matched by email
// automatically, with a manual matching screen for admins).
// GET /api/admin/people-matches, PUT /api/admin/people-matches/:userId.
//
// Visible to platform admins only: anyone else gets an explanation and no
// request is made. The API enforces it on its own.

import { useEffect, useState } from 'react'
import { LoaderCircle, ShieldX, Users } from 'lucide-react'
import type { BcPerson, CurrentUser, PeopleMatchesResponse } from '@naf-sheets/shared'
import { AppBar } from '../components/AppBar'
import { Notice } from '../components/Notice'
import { api, errorMessage, isAbortError } from '../lib/api'
import { Link } from '../lib/router'
import { pathFor } from '../lib/routes'
import { useDocumentTitle } from '../lib/use-document-title'
import { t } from '../strings'

type Match = PeopleMatchesResponse['matches'][number]
type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: PeopleMatchesResponse }
type RowStatus = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string }

export function PeopleMatchesScreen({ user, userSettled }: { user: CurrentUser | null; userSettled: boolean }) {
  useDocumentTitle(t.people.title)
  const isAdmin = user?.role === 'admin'

  return (
    <>
      <a className="skip-link" href="#main">
        {t.skipToContent}
      </a>
      <AppBar user={user} />
      <main id="main" className="page" data-screen="people-matches">
        <div className="page-head">
          <h1>{t.people.title}</h1>
        </div>
        {!userSettled ? (
          <div className="panel panel--plain" role="status">
            <LoaderCircle className="panel__icon spin" aria-hidden="true" />
            <p>{t.people.loading}</p>
          </div>
        ) : isAdmin ? (
          <PeopleMatches />
        ) : (
          <section className="panel" data-testid="people-admin-only">
            <ShieldX className="panel__icon" aria-hidden="true" />
            <h2>{t.people.adminOnlyTitle}</h2>
            <p>{t.people.adminOnlyBody}</p>
            <Link className="button" href={pathFor({ name: 'settings' })}>
              {t.settings.title}
            </Link>
          </section>
        )}
      </main>
    </>
  )
}

function PeopleMatches() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    api.getPeopleMatches(controller.signal).then(
      (data) => setLoad({ kind: 'ready', data }),
      (error: unknown) => {
        if (!isAbortError(error)) setLoad({ kind: 'error', message: errorMessage(error) })
      },
    )
    return () => controller.abort()
  }, [attempt])

  // `#match-<user id>` (a link from «أعضاء المنصة»): bring that member's row
  // into view and focus its select once the list is shown.
  const ready = load.kind === 'ready'
  useEffect(() => {
    if (!ready || !window.location.hash.startsWith('#match-')) return
    let id: string
    try {
      id = decodeURIComponent(window.location.hash.slice(1))
    } catch {
      return
    }
    const select = document.getElementById(id)
    if (!(select instanceof HTMLSelectElement)) return
    select.scrollIntoView({ block: 'center' })
    select.focus()
  }, [ready])

  if (load.kind === 'loading') {
    return (
      <div className="panel panel--plain" role="status">
        <LoaderCircle className="panel__icon spin" aria-hidden="true" />
        <p>{t.people.loading}</p>
      </div>
    )
  }
  if (load.kind === 'error') {
    return (
      <Notice
        tone="danger"
        testId="people-error"
        actions={
          <button type="button" className="button button--small" onClick={() => setAttempt((n) => n + 1)}>
            {t.files.retry}
          </button>
        }
      >
        <p>{load.message}</p>
      </Notice>
    )
  }
  if (load.data.matches.length === 0) {
    return (
      <section className="panel">
        <Users className="panel__icon" aria-hidden="true" />
        <h2>{t.people.emptyTitle}</h2>
        <p>{t.people.emptyBody}</p>
      </section>
    )
  }

  const people = [...load.data.people].sort((a, b) => a.name.localeCompare(b.name, 'ar'))
  return (
    <>
      <p className="lead">{t.people.intro}</p>
      <div className="table-wrap">
        <table className="data-table" data-testid="people-table">
          <caption className="sr-only">{t.people.title}</caption>
          <thead>
            <tr>
              <th scope="col">{t.people.columns.member}</th>
              <th scope="col">{t.people.columns.person}</th>
              <th scope="col">{t.people.columns.source}</th>
              <th scope="col">{t.people.columns.action}</th>
            </tr>
          </thead>
          <tbody>
            {load.data.matches.map((m) => (
              <MatchRow
                key={m.userId}
                match={m}
                people={people}
                // The list is read again after a save: what is shown is what the API stored.
                onSaved={() =>
                  api.getPeopleMatches().then(
                    (data) => setLoad({ kind: 'ready', data }),
                    () => undefined,
                  )
                }
              />
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function personLabel(p: BcPerson): string {
  const parts = [p.name]
  if (p.email) parts.push(p.email)
  let label = parts.join(' — ')
  if (p.client) label += ` (${t.people.client})`
  return label
}

function MatchRow({ match, people, onSaved }: { match: Match; people: BcPerson[]; onSaved: () => Promise<void> }) {
  const stored = match.bcPersonId === null ? '' : String(match.bcPersonId)
  const [value, setValue] = useState(stored)
  const [status, setStatus] = useState<RowStatus>({ kind: 'idle' })
  const member = match.name || match.email || t.people.unnamed
  const selectId = `match-${match.userId}`

  // A fresh list from the API replaces the row's value.
  useEffect(() => setValue(stored), [stored])

  const save = async () => {
    setStatus({ kind: 'saving' })
    try {
      await api.putPeopleMatch(match.userId, { bcPersonId: value === '' ? null : Number(value) })
      await onSaved()
      setStatus({ kind: 'saved' })
    } catch (error) {
      setStatus({ kind: 'error', message: errorMessage(error) })
    }
  }

  const sourceLabel = match.source === 'email' ? t.people.source.email : match.source === 'manual' ? t.people.source.manual : t.people.source.none
  return (
    <tr data-user-id={match.userId}>
      <td>
        <div className="stack-tight">
          <bdi>{member}</bdi>
          {match.email && match.name ? (
            <bdi className="muted small" dir="ltr">
              {match.email}
            </bdi>
          ) : null}
        </div>
      </td>
      <td>
        <label htmlFor={selectId} className="sr-only">
          {t.people.selectLabel(member)}
        </label>
        <select
          id={selectId}
          className="select"
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setStatus({ kind: 'idle' })
          }}
          disabled={status.kind === 'saving'}
        >
          <option value="">{t.people.noPerson}</option>
          {people.map((p) => (
            <option key={p.id} value={String(p.id)}>
              {personLabel(p)}
            </option>
          ))}
        </select>
      </td>
      <td>
        <span className={match.source ? 'badge badge--neutral' : 'badge badge--warning'} data-source={match.source ?? 'none'}>
          {sourceLabel}
        </span>
      </td>
      <td>
        <div className="row-actions">
          <button type="button" className="button button--small" onClick={() => void save()} disabled={value === stored || status.kind === 'saving'}>
            {status.kind === 'saving' ? <LoaderCircle className="icon spin" aria-hidden="true" /> : null}
            {status.kind === 'saving' ? t.people.saving : t.people.save}
          </button>
          {status.kind === 'saved' ? (
            <span className="muted small" role="status">
              {t.people.saved}
            </span>
          ) : null}
          {status.kind === 'error' ? (
            <span className="field-error" role="alert">
              {status.message}
            </span>
          ) : null}
        </div>
      </td>
    </tr>
  )
}
