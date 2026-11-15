// The station screens (docs/station-plan.md §6): links, new link, one link,
// name matching. The platform shows no sheet of its own: it only links.

import { useEffect, useState, type ReactNode } from 'react'
import { ArrowLeftRight, ExternalLink, LoaderCircle, Pause, Play, Plus, RefreshCw, Trash2, Unlink, Users } from 'lucide-react'
import type { CurrentUser } from '@naf-sheets/shared'
import { AppBar } from '../components/AppBar'
import { Notice } from '../components/Notice'
import { errorMessage } from '../lib/api'
import { Link, navigate } from '../lib/router'
import { useDocumentTitle } from '../lib/use-document-title'
import { t } from '../strings'
import { stationApi, type Inspection, type LinkDetail, type LinkSummary, type NamesResponse, type StationAlert } from './api'
import { s } from './strings'

type Load<T> = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: T }

function useLoad<T>(fetcher: (signal: AbortSignal) => Promise<T>, deps: unknown[]): [Load<T>, () => void] {
  const [state, setState] = useState<Load<T>>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    fetcher(controller.signal).then(
      (data) => setState({ kind: 'ready', data }),
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ kind: 'error', message: errorMessage(error) })
      },
    )
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, attempt])
  return [state, () => setAttempt((n) => n + 1)]
}

function Page({ user, title, screen, actions, children }: { user: CurrentUser | null; title: string; screen: string; actions?: ReactNode; children: ReactNode }) {
  useDocumentTitle(title)
  return (
    <>
      <a className="skip-link" href="#main">
        {t.skipToContent}
      </a>
      <AppBar user={user} />
      <main id="main" className="page" data-screen={screen}>
        <nav className="station-nav" aria-label={s.nav.links}>
          <Link href="/" className="station-nav__link">
            <ArrowLeftRight className="icon" aria-hidden="true" />
            {s.nav.links}
          </Link>
          <Link href="/names" className="station-nav__link">
            <Users className="icon" aria-hidden="true" />
            {s.nav.names}
          </Link>
        </nav>
        <div className="page-head">
          <h1>{title}</h1>
          {actions}
        </div>
        {children}
      </main>
    </>
  )
}

function Loading({ text }: { text: string }) {
  return (
    <div className="panel panel--plain" role="status">
      <LoaderCircle className="panel__icon spin" aria-hidden="true" />
      <p>{text}</p>
    </div>
  )
}

function Failed({ message, retry }: { message: string; retry: () => void }) {
  return (
    <Notice
      tone="danger"
      actions={
        <button type="button" className="button button--small" onClick={retry}>
          {t.files.retry}
        </button>
      }
    >
      <p>{message}</p>
    </Notice>
  )
}

// --- الروابط ----------------------------------------------------------------------

export function LinksScreen({ user }: { user: CurrentUser | null }) {
  const [load, retry] = useLoad((signal) => stationApi.links(signal), [])
  const isAdmin = user?.role === 'admin'
  return (
    <Page
      user={user}
      title={s.links.title}
      screen="station-links"
      actions={
        isAdmin ? (
          <Link href="/links/new" className="button button--primary">
            <Plus className="icon" aria-hidden="true" />
            {s.links.add}
          </Link>
        ) : null
      }
    >
      <p className="lead">{s.links.lead}</p>
      {load.kind === 'loading' ? <Loading text={s.links.loading} /> : null}
      {load.kind === 'error' ? <Failed message={load.message} retry={retry} /> : null}
      {load.kind === 'ready' && load.data.links.length === 0 ? (
        <section className="panel">
          <ArrowLeftRight className="panel__icon" aria-hidden="true" />
          <p>{s.links.empty}</p>
        </section>
      ) : null}
      {load.kind === 'ready' ? (
        <div className="station-cards">
          {load.data.links.map((l) => (
            <LinkCard key={l.id} link={l} />
          ))}
        </div>
      ) : null}
    </Page>
  )
}

function LinkCard({ link }: { link: LinkSummary }) {
  return (
    <Link href={`/links/${encodeURIComponent(link.id)}`} className="card station-card" data-testid="link-card">
      <div className="card__head">
        <h2>
          <bdi>{link.title}</bdi>
        </h2>
        <span className={link.state === 'paused' ? 'badge badge--neutral' : 'badge badge--success'}>{link.state === 'paused' ? s.links.paused : s.links.active}</span>
      </div>
      <p className="muted small">
        {s.links.tabs(link.tabs)} · {s.links.lastSync}: <bdi dir="ltr">{s.date(link.last_sync_at)}</bdi>
      </p>
      <span className={link.problems > 0 ? 'badge badge--warning' : 'badge badge--neutral'}>{s.links.problems(link.problems)}</span>
    </Link>
  )
}

// --- ربط جديد -----------------------------------------------------------------------

export function NewLinkScreen({ user }: { user: CurrentUser | null }) {
  const [source, setSource] = useState('')
  const [rolesTab, setRolesTab] = useState('المسميات')
  const [inspection, setInspection] = useState<Load<Inspection> | null>(null)
  const [tabs, setTabs] = useState<number[]>([])
  const [projectId, setProjectId] = useState('')
  const [projects] = useLoad((signal) => stationApi.projects(signal), [])
  const [submit, setSubmit] = useState<{ kind: 'idle' } | { kind: 'saving' } | { kind: 'error'; message: string }>({ kind: 'idle' })

  if (user && user.role !== 'admin') {
    return (
      <Page user={user} title={s.wizard.title} screen="station-new">
        <Notice tone="warning">
          <p>{t.adminOnly.body}</p>
        </Notice>
      </Page>
    )
  }

  const inspect = async () => {
    setInspection({ kind: 'loading' })
    setTabs([])
    try {
      const data = await stationApi.inspect(source, rolesTab)
      setInspection({ kind: 'ready', data })
      setTabs(data.tabs.filter((x) => x.linkable).map((x) => x.sheetId))
    } catch (error) {
      setInspection({ kind: 'error', message: errorMessage(error) })
    }
  }

  const create = async () => {
    if (tabs.length === 0) return setSubmit({ kind: 'error', message: s.wizard.needTabs })
    if (!projectId) return setSubmit({ kind: 'error', message: s.wizard.needProject })
    setSubmit({ kind: 'saving' })
    try {
      const { id } = await stationApi.createLink({ source, bcProjectId: Number(projectId), tabs, rolesTab })
      navigate(`/links/${encodeURIComponent(id)}`)
    } catch (error) {
      setSubmit({ kind: 'error', message: errorMessage(error) })
    }
  }

  const ready = inspection?.kind === 'ready' ? inspection.data : null
  return (
    <Page user={user} title={s.wizard.title} screen="station-new">
      <div className="stack">
      <section className="card stack">
        <h2>1. {s.wizard.step1}</h2>
        <div className="field">
          <label htmlFor="source">{s.wizard.step1}</label>
          <input id="source" dir="ltr" value={source} onChange={(e) => setSource(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" />
          <p className="field-hint">{s.wizard.sourceHint}</p>
        </div>
        <div className="field">
          <label htmlFor="roles-tab">{s.wizard.rolesTab}</label>
          <input id="roles-tab" value={rolesTab} onChange={(e) => setRolesTab(e.target.value)} />
          <p className="field-hint">{s.wizard.rolesTabHint}</p>
        </div>
        <div className="card__actions">
          <button type="button" className="button" onClick={() => void inspect()} disabled={source.trim() === '' || inspection?.kind === 'loading'}>
            {inspection?.kind === 'loading' ? <LoaderCircle className="icon spin" aria-hidden="true" /> : <RefreshCw className="icon" aria-hidden="true" />}
            {inspection?.kind === 'loading' ? s.wizard.inspecting : s.wizard.inspect}
          </button>
        </div>
        {inspection?.kind === 'error' ? (
          <Notice tone="danger">
            <p>{inspection.message}</p>
          </Notice>
        ) : null}
      </section>

      {ready ? (
        <>
          <section className="card stack">
            <h2>
              2. {s.wizard.step2} — <bdi>{ready.title}</bdi>
            </h2>
            <p className="muted">{s.wizard.step2Hint}</p>
            {!ready.hasRolesTab ? (
              <Notice tone="warning">
                <p>{s.wizard.noRolesTab(rolesTab)}</p>
              </Notice>
            ) : null}
            <ul className="station-tabs">
              {ready.tabs.map((tab) => (
                <li key={tab.sheetId}>
                  {tab.linkable ? (
                    <label className="station-tab">
                      <input
                        type="checkbox"
                        checked={tabs.includes(tab.sheetId)}
                        onChange={(e) => setTabs((cur) => (e.target.checked ? [...cur, tab.sheetId] : cur.filter((x) => x !== tab.sheetId)))}
                      />
                      <span>
                        <strong>
                          <bdi>{tab.title}</bdi>
                        </strong>{' '}
                        <span className="muted small">{s.wizard.counts(tab.todos ?? 0, tab.subtasks ?? 0)}</span>
                      </span>
                    </label>
                  ) : (
                    <p className="muted small">
                      <bdi>{tab.title}</bdi> — {s.wizard.notLinkable} {tab.reason}
                    </p>
                  )}
                  {tab.linkable && tab.held && tab.held.length > 0 ? (
                    <details className="small">
                      <summary>{s.wizard.held(tab.held.length)}</summary>
                      <ul>
                        {tab.held.map((h, i) => (
                          <li key={i}>{h}</li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
          <section className="card stack">
            <h2>3. {s.wizard.step3}</h2>
            {projects.kind === 'loading' ? <Loading text={s.wizard.loadingProjects} /> : null}
            {projects.kind === 'error' ? (
              <Notice tone="danger">
                <p>{projects.message}</p>
              </Notice>
            ) : null}
            {projects.kind === 'ready' ? (
              <div className="field">
                <label htmlFor="project">{s.wizard.chooseProject}</label>
                <select id="project" className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  <option value="">{s.wizard.chooseProject}</option>
                  {projects.data.projects.map((p) => (
                    <option key={p.id} value={String(p.id)} disabled={p.todosetId === null}>
                      {p.name} {p.todosetId === null ? s.wizard.todosOff : ''}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <Notice tone="info">
              <p>{s.wizard.firstSync}</p>
            </Notice>
            {submit.kind === 'error' ? (
              <p className="field-error" role="alert">
                {submit.message}
              </p>
            ) : null}
            <div className="card__actions">
              <button type="button" className="button button--primary" onClick={() => void create()} disabled={submit.kind === 'saving'}>
                {submit.kind === 'saving' ? <LoaderCircle className="icon spin" aria-hidden="true" /> : <ArrowLeftRight className="icon" aria-hidden="true" />}
                {submit.kind === 'saving' ? s.wizard.creating : s.wizard.create}
              </button>
            </div>
          </section>
        </>
      ) : null}
      </div>
    </Page>
  )
}

// --- ربط واحد -------------------------------------------------------------------------

export function alertText(a: StationAlert): string {
  switch (a.kind) {
    case 'name_unmapped':
      return s.alert.name_unmapped(a)
    case 'not_project_member':
      return s.alert.not_project_member(a)
    case 'rows_held':
      return `«${a.tab}»: ${a.reason}${a.rows > 1 ? ` (${s.rows(a.rows)})` : ''}`
    case 'tab_stopped':
      return `«${a.tab}»: ${a.reason}`
    case 'link_stopped':
      return a.reason
  }
}

export function LinkScreen({ user, id }: { user: CurrentUser | null; id: string }) {
  const [load, reload] = useLoad((signal) => stationApi.link(id, signal), [id])
  const [flash, setFlash] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const isAdmin = user?.role === 'admin'
  const title = load.kind === 'ready' ? load.data.link.title : s.link.loading

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true)
    setFlash(null)
    try {
      await fn()
      if (done) setFlash({ tone: 'info', text: done })
      reload()
    } catch (error) {
      setFlash({ tone: 'danger', text: errorMessage(error) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Page user={user} title={title} screen="station-link">
      {load.kind === 'loading' ? <Loading text={s.link.loading} /> : null}
      {load.kind === 'error' ? <Failed message={load.message} retry={reload} /> : null}
      {flash ? (
        <Notice tone={flash.tone}>
          <p>{flash.text}</p>
        </Notice>
      ) : null}
      {load.kind === 'ready' ? <LinkBody detail={load.data} isAdmin={isAdmin} busy={busy} act={act} /> : null}
    </Page>
  )
}

function LinkBody({ detail, isAdmin, busy, act }: { detail: LinkDetail; isAdmin: boolean; busy: boolean; act: (fn: () => Promise<unknown>, done?: string) => Promise<void> }) {
  const { link, tabs, problems, log } = detail
  return (
    <div className="stack">
      <section className="card stack">
        <p className="muted small">
          {s.links.lastSync}: <bdi dir="ltr">{s.date(link.last_sync_at)}</bdi> · {link.state === 'paused' ? s.links.paused : s.links.active}
        </p>
        <div className="card__actions">
          <a className="button button--ghost" href={`https://docs.google.com/spreadsheets/d/${encodeURIComponent(link.spreadsheet_id)}/edit`} target="_blank" rel="noreferrer">
            <ExternalLink className="icon" aria-hidden="true" />
            {s.link.file}
          </a>
          {isAdmin ? (
            <>
              <button type="button" className="button" disabled={busy} onClick={() => void act(() => stationApi.syncNow(link.id), s.link.syncQueued)}>
                <RefreshCw className="icon" aria-hidden="true" />
                {s.link.syncNow}
              </button>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => void act(() => stationApi.updateLink(link.id, { state: link.state === 'paused' ? 'active' : 'paused' }))}
              >
                {link.state === 'paused' ? <Play className="icon" aria-hidden="true" /> : <Pause className="icon" aria-hidden="true" />}
                {link.state === 'paused' ? s.link.resume : s.link.pause}
              </button>
              <button
                type="button"
                className="button button--danger"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(s.link.unlinkConfirm)) void act(() => stationApi.deleteLink(link.id).then(() => navigate('/')))
                }}
              >
                <Unlink className="icon" aria-hidden="true" />
                {s.link.unlink}
              </button>
            </>
          ) : null}
        </div>
      </section>

      <section className="card stack" data-testid="link-problems">
        <h2>{s.link.problems}</h2>
        {problems.length === 0 ? <p className="muted">{s.link.noProblems}</p> : null}
        <ul className="station-problems">
          {problems.map((p) => (
            <li key={p.key}>
              <p>{alertText(p.alert)}</p>
              <p className="muted small">
                <bdi dir="ltr">{s.date(p.firstSeen)}</bdi>
                {p.emailedAt ? ` · ${s.link.emailed}` : ''}
              </p>
              {p.alert.kind === 'name_unmapped' ? (
                <Link className="button button--small" href={`/names?name=${encodeURIComponent(p.alert.name)}`}>
                  {s.alert.linkName}
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="card stack">
        <h2>{s.link.tabs}</h2>
        <ul>
          {tabs.map((tab) => (
            <li key={tab.google_sheet_id}>
              <bdi>{tab.title}</bdi>
              {tab.bc_todolist_id === null ? <span className="muted small"> — {s.link.noList}</span> : null}
            </li>
          ))}
        </ul>
        {isAdmin ? <RolesTabEditor id={link.id} value={link.roles_tab} act={act} busy={busy} /> : null}
      </section>

      <section className="card stack">
        <h2>{s.link.history}</h2>
        {log.length === 0 ? <p className="muted">{s.link.noHistory}</p> : null}
        <div className="table-wrap">
          <table className="data-table">
            <tbody>
              {log.map((l, i) => (
                <tr key={i}>
                  <td>
                    <bdi dir="ltr">{s.date(l.at)}</bdi>
                  </td>
                  <td>{l.direction === 'to_sheet' ? s.link.toSheet : s.link.toBasecamp}</td>
                  <td>{s.link.actions[l.action] ?? l.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function RolesTabEditor({ id, value, act, busy }: { id: string; value: string; act: (fn: () => Promise<unknown>, done?: string) => Promise<void>; busy: boolean }) {
  const [tab, setTab] = useState(value)
  return (
    <div className="field field--inline">
      <label htmlFor="roles-tab-edit">{s.link.rolesTab}</label>
      <input id="roles-tab-edit" value={tab} onChange={(e) => setTab(e.target.value)} />
      <button type="button" className="button button--small" disabled={busy || tab.trim() === '' || tab === value} onClick={() => void act(() => stationApi.updateLink(id, { rolesTab: tab.trim() }), s.link.saved)}>
        {s.link.save}
      </button>
    </div>
  )
}

// --- مطابقة الأسماء ------------------------------------------------------------------------

export function NamesScreen({ user, focusName, suggest }: { user: CurrentUser | null; focusName?: string; suggest?: number }) {
  const [load, reload] = useLoad((signal) => stationApi.names(signal), [])
  const isAdmin = user?.role === 'admin'
  return (
    <Page user={user} title={s.names.title} screen="station-names">
      <p className="lead">{s.names.lead}</p>
      {load.kind === 'loading' ? <Loading text={s.names.loading} /> : null}
      {load.kind === 'error' ? <Failed message={load.message} retry={reload} /> : null}
      {load.kind === 'ready' ? <NamesBody data={load.data} isAdmin={isAdmin} reload={reload} focusName={focusName} suggest={suggest} /> : null}
    </Page>
  )
}

function NamesBody({ data, isAdmin, reload, focusName, suggest }: { data: NamesResponse; isAdmin: boolean; reload: () => void; focusName?: string; suggest?: number }) {
  const people = [...data.people].sort((a, b) => a.name.localeCompare(b.name, 'ar'))
  const personName = new Map(people.map((p) => [p.id, p.name]))
  const unmapped = new Map<string, NamesResponse['unmapped'][number]>()
  for (const u of data.unmapped) if (!unmapped.has(u.name)) unmapped.set(u.name, u)
  // A name opened from an email that is not (or no longer) in the open list.
  const extra = focusName && !unmapped.has(focusName) && !data.names.some((n) => n.name === focusName) ? [focusName] : []
  return (
    <div className="stack">
      <section className="card stack" data-testid="names-unmapped">
        <h2>{s.names.unmapped}</h2>
        {unmapped.size + extra.length === 0 ? <p className="muted">{s.names.noUnmapped}</p> : null}
        {[...unmapped.values()].map((u) => (
          <NameRow
            key={u.name}
            name={u.name}
            hint={s.names.where(u)}
            suggestion={u.suggestion ? s.names.suggestion(u.suggestion.personName, u.suggestion.previousName) : undefined}
            initial={u.name === focusName && suggest ? String(suggest) : u.suggestion ? String(u.suggestion.bcPersonId) : ''}
            people={people}
            isAdmin={isAdmin}
            focus={u.name === focusName}
            onSaved={reload}
          />
        ))}
        {extra.map((name) => (
          <NameRow key={name} name={name} initial={suggest ? String(suggest) : ''} people={people} isAdmin={isAdmin} focus onSaved={reload} />
        ))}
      </section>
      <section className="card stack">
        <h2>{s.names.mapped}</h2>
        {data.names.length === 0 ? <p className="muted">{s.names.noMapped}</p> : null}
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{s.names.name}</th>
                <th scope="col">{s.names.person}</th>
                <th scope="col">{s.names.source}</th>
              </tr>
            </thead>
            <tbody>
              {data.names.map((n) => (
                <tr key={n.name}>
                  <td>
                    <NameRow name={n.name} initial={String(n.bc_person_id)} people={people} isAdmin={isAdmin} focus={n.name === focusName} onSaved={reload} compact />
                  </td>
                  <td>
                    <bdi>{personName.get(n.bc_person_id) ?? n.bc_person_id}</bdi>
                  </td>
                  <td>
                    <span className="badge badge--neutral">{n.source === 'auto' ? s.names.auto : s.names.manual}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function NameRow({
  name,
  hint,
  suggestion,
  initial,
  people,
  isAdmin,
  focus,
  onSaved,
  compact,
}: {
  name: string
  hint?: string
  suggestion?: string
  initial: string
  people: { id: number; name: string }[]
  isAdmin: boolean
  focus?: boolean
  onSaved: () => void
  compact?: boolean
}) {
  const [value, setValue] = useState(initial)
  const [status, setStatus] = useState<{ kind: 'idle' | 'saving' | 'saved' } | { kind: 'error'; message: string }>({ kind: 'idle' })
  const id = `name-${encodeURIComponent(name)}`
  useEffect(() => {
    if (focus) document.getElementById(id)?.scrollIntoView({ block: 'center' })
  }, [focus, id])
  const save = async () => {
    setStatus({ kind: 'saving' })
    try {
      await stationApi.putName(name, Number(value))
      setStatus({ kind: 'saved' })
      onSaved()
    } catch (error) {
      setStatus({ kind: 'error', message: errorMessage(error) })
    }
  }
  return (
    <div className={focus ? 'station-name station-name--focus' : 'station-name'} data-name={name}>
      <div className="stack-tight">
        <strong>
          <bdi>{name}</bdi>
        </strong>
        {hint ? <span className="muted small">{hint}</span> : null}
        {suggestion ? <span className="small">{suggestion}</span> : null}
      </div>
      {isAdmin && !compact ? (
        <div className="row-actions">
          <label htmlFor={id} className="sr-only">
            {s.names.choose}
          </label>
          <select id={id} className="select" value={value} onChange={(e) => setValue(e.target.value)} disabled={status.kind === 'saving'}>
            <option value="">{s.names.choose}</option>
            {people.map((p) => (
              <option key={p.id} value={String(p.id)}>
                {p.name}
              </option>
            ))}
          </select>
          <button type="button" className="button button--small button--primary" disabled={value === '' || status.kind === 'saving'} onClick={() => void save()}>
            {status.kind === 'saving' ? s.names.saving : s.names.save}
          </button>
          {status.kind === 'saved' ? (
            <span className="muted small" role="status">
              {s.names.saved}
            </span>
          ) : null}
          {status.kind === 'error' ? (
            <span className="field-error" role="alert">
              {status.message}
            </span>
          ) : null}
        </div>
      ) : null}
      {isAdmin && compact ? (
        <button
          type="button"
          className="button button--small button--ghost"
          onClick={() => void stationApi.deleteName(name).then(onSaved, (e: unknown) => setStatus({ kind: 'error', message: errorMessage(e) }))}
        >
          <Trash2 className="icon" aria-hidden="true" />
          {s.names.remove}
        </button>
      ) : null}
    </div>
  )
}
