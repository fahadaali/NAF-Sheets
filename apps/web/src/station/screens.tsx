// The station screens (docs/station-plan.md §6): links, new link, one link,
// name matching. The platform shows no sheet of its own: it only links.

import { useEffect, useState, type ReactNode } from 'react'
import { ArrowLeftRight, ChevronLeft, CircleCheck, ExternalLink, FileSpreadsheet, LoaderCircle, Pause, Play, Plus, RefreshCw, RotateCcw, Trash2, TriangleAlert, Unlink } from 'lucide-react'
import type { CurrentUser } from '@naf-sheets/shared'
import { AppBar } from '../components/AppBar'
import { PageHeader } from '../components/PageHeader'
import { Notice } from '../components/Notice'
import { errorMessage } from '../lib/api'
import { Link, navigate } from '../lib/router'
import { useDocumentTitle } from '../lib/use-document-title'
import { t } from '../strings'
import { stationApi, type FirstSyncReference, type Inspection, type LinkDetail, type LinkRequest, type LinkSummary, type NamesResponse, type Preview, type StationAlert } from './api'
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

function Page({
  user,
  title,
  screen,
  back,
  subtitle,
  actions,
  children,
}: {
  user: CurrentUser | null
  title: string
  screen: string
  back?: { href: string; label: string }
  subtitle?: ReactNode
  actions?: ReactNode
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
        <PageHeader title={title} back={back} subtitle={subtitle} actions={actions} />
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
          {t.common.retry}
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
  const links = load.kind === 'ready' ? load.data.links : []
  return (
    <Page
      user={user}
      title={s.links.title}
      screen="station-links"
      subtitle={s.links.lead}
      actions={
        isAdmin ? (
          <Link href="/links/new" className="button button--primary">
            <Plus className="icon" aria-hidden="true" />
            {s.links.add}
          </Link>
        ) : null
      }
    >
      <div className="stack">
        <SetupWarning />
        {load.kind === 'loading' ? <Loading text={s.links.loading} /> : null}
        {load.kind === 'error' ? <Failed message={load.message} retry={retry} /> : null}
        {load.kind === 'ready' && links.length === 0 ? (
          <section className="panel">
            <ArrowLeftRight className="panel__icon" aria-hidden="true" />
            <p>{s.links.empty}</p>
          </section>
        ) : null}
        {load.kind === 'ready' ? (
          <div className="station-cards">
            {links.map((l) => (
              <LinkCard key={l.id} link={l} />
            ))}
          </div>
        ) : null}
      </div>
    </Page>
  )
}

/** On the links page: a link cannot sync without the sync account and the Google key; says where to fix it. */
function SetupWarning() {
  const [load] = useLoad((signal) => stationApi.status(signal), [])
  if (load.kind !== 'ready') return null
  const { basecamp, google } = load.data
  if (basecamp?.status === 'active' && google !== null) return null
  return (
    <Notice tone="warning">
      <p>
        <strong>{s.setup.incomplete}</strong>{' '}
        <Link href="/settings">{s.setup.open}</Link>
      </p>
    </Notice>
  )
}

/** The three things a link needs (§5), in Settings. */
export function SetupCard({ isAdmin }: { isAdmin: boolean }) {
  const [load] = useLoad((signal) => stationApi.status(signal), [])
  if (load.kind !== 'ready') return null
  const { basecamp, google, email } = load.data
  const bcOk = basecamp?.status === 'active'
  const next = typeof window === 'undefined' ? '/settings' : window.location.pathname
  const connect = `/auth/basecamp/start?${new URLSearchParams({ service: '1', next }).toString()}`
  const item = (ok: boolean, title: string, text: string, action?: ReactNode) => (
    <li className="station-setup__item">
      {ok ? <CircleCheck className="icon station-setup__ok" aria-label={s.setup.ready} /> : <TriangleAlert className="icon station-setup__missing" aria-label={s.setup.missing} />}
      <div className="stack-tight">
        <strong>{title}</strong>
        <span className="muted small">{text}</span>
        {action}
      </div>
    </li>
  )
  return (
    <section className="card stack station-setup" data-testid="station-setup">
      <h2>{s.setup.title}</h2>
      <p className="muted small">{s.setup.lead}</p>
      <ul className="station-setup__list">
        {item(
          bcOk,
          s.setup.basecamp,
          bcOk ? s.setup.basecampOk(basecamp?.name ?? null) : basecamp ? s.setup.basecampExpired : s.setup.basecampMissing,
          isAdmin ? (
            <a className="button button--small" href={connect} title={s.setup.basecampHint}>
              {bcOk ? s.setup.basecampReconnect : s.setup.basecampConnect}
            </a>
          ) : null,
        )}
        {item(google !== null, s.setup.google, google ? s.setup.googleOk(google) : s.setup.googleMissing)}
        {item(email, s.setup.email, email ? s.setup.emailOk : s.setup.emailMissing)}
        {item(true, s.setup.schedule, s.setup.scheduleText)}
      </ul>
    </section>
  )
}

function LinkCard({ link }: { link: LinkSummary }) {
  const tone = link.state === 'paused' ? 'neutral' : link.problems > 0 ? 'warning' : 'success'
  return (
    <Link href={`/links/${encodeURIComponent(link.id)}`} className="card station-card" data-testid="link-card">
      <div className="station-card__head">
        <span className={`station-card__icon station-card__icon--${tone}`}>
          <FileSpreadsheet className="icon" aria-hidden="true" />
        </span>
        <div className="station-card__titles">
          <h2>
            <bdi>{link.title}</bdi>
          </h2>
          <span className="muted small">{s.links.tabs(link.tabs)}</span>
        </div>
        <ChevronLeft className="icon station-card__go" aria-hidden="true" />
      </div>
      <div className="station-card__foot">
        <span className={`badge badge--${link.state === 'paused' ? 'neutral' : 'success'}`}>{link.state === 'paused' ? s.links.paused : s.links.active}</span>
        <span className={link.problems > 0 ? 'badge badge--warning' : 'badge badge--neutral'}>{s.links.problems(link.problems)}</span>
      </div>
    </Link>
  )
}

// --- ربط جديد -----------------------------------------------------------------------

export function NewLinkScreen({ user }: { user: CurrentUser | null }) {
  if (user && user.role !== 'admin') {
    return (
      <Page user={user} title={s.wizard.title} screen="station-new" back={{ href: '/', label: s.links.title }} subtitle={s.wizard.lead}>
        <Notice tone="warning">
          <p>{t.adminOnly.body}</p>
        </Notice>
      </Page>
    )
  }
  return <NewLinkWizard user={user} />
}

function NewLinkWizard({ user }: { user: CurrentUser | null }) {
  const [source, setSource] = useState('')
  const [rolesTab, setRolesTab] = useState('المسميات')
  const [inspection, setInspection] = useState<Load<Inspection> | null>(null)
  const [tabs, setTabs] = useState<number[]>([])
  const [projectId, setProjectId] = useState('')
  const [projects] = useLoad((signal) => stationApi.projects(signal), [])
  /** Tab → existing list id ('' = a new list). */
  const [listOf, setListOf] = useState<Record<number, string>>({})
  const [reference, setReference] = useState<FirstSyncReference>('merge')
  const [lists, setLists] = useState<Load<{ id: number; name: string; linked: boolean }[]> | null>(null)
  const [preview, setPreview] = useState<{ kind: 'loading' } | { kind: 'ready'; data: Preview; for: string } | { kind: 'error'; message: string } | null>(null)
  const [submit, setSubmit] = useState<{ kind: 'idle' } | { kind: 'saving' } | { kind: 'error'; message: string }>({ kind: 'idle' })

  useEffect(() => {
    setListOf({})
    if (!projectId) return setLists(null)
    const controller = new AbortController()
    setLists({ kind: 'loading' })
    stationApi.lists(Number(projectId), controller.signal).then(
      (data) => setLists({ kind: 'ready', data: data.lists }),
      (error: unknown) => {
        if (!controller.signal.aborted) setLists({ kind: 'error', message: errorMessage(error) })
      },
    )
    return () => controller.abort()
  }, [projectId])

  const request = (): LinkRequest => ({
    source,
    bcProjectId: Number(projectId),
    tabs: tabs.map((sheetId) => ({ sheetId, listId: listOf[sheetId] ? Number(listOf[sheetId]) : null })),
    rolesTab,
    reference,
  })
  // The preview stands for exactly these choices; any change asks for a new one.
  const requestKey = JSON.stringify(request())
  const previewed = preview?.kind === 'ready' && preview.for === requestKey
  const usesExisting = tabs.some((t) => Boolean(listOf[t]))

  const showPreview = async () => {
    if (tabs.length === 0) return setSubmit({ kind: 'error', message: s.wizard.needTabs })
    if (!projectId) return setSubmit({ kind: 'error', message: s.wizard.needProject })
    setSubmit({ kind: 'idle' })
    setPreview({ kind: 'loading' })
    try {
      setPreview({ kind: 'ready', data: await stationApi.preview(request()), for: requestKey })
    } catch (error) {
      setPreview({ kind: 'error', message: errorMessage(error) })
    }
  }

  // A changed file or roles tab makes the inspection stale: inspect again before linking.
  const changeInput = (set: (value: string) => void, value: string) => {
    set(value)
    setInspection(null)
    setTabs([])
    setSubmit({ kind: 'idle' })
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
    if (!previewed) return setSubmit({ kind: 'error', message: s.wizard.previewFirst })
    setSubmit({ kind: 'saving' })
    try {
      const { id } = await stationApi.createLink(request())
      navigate(`/links/${encodeURIComponent(id)}`)
    } catch (error) {
      setSubmit({ kind: 'error', message: errorMessage(error) })
    }
  }

  const ready = inspection?.kind === 'ready' ? inspection.data : null
  return (
    <Page user={user} title={s.wizard.title} screen="station-new" back={{ href: '/', label: s.links.title }} subtitle={s.wizard.lead}>
      <div className="stack">
      <section className="card stack">
        <h2>1. {s.wizard.step1}</h2>
        <div className="field">
          <label htmlFor="source">{s.wizard.step1}</label>
          <input id="source" dir="ltr" value={source} onChange={(e) => changeInput(setSource, e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" />
          <p className="field-hint">{s.wizard.sourceHint}</p>
        </div>
        <div className="field">
          <label htmlFor="roles-tab">{s.wizard.rolesTab}</label>
          <input id="roles-tab" value={rolesTab} onChange={(e) => changeInput(setRolesTab, e.target.value)} />
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
          </section>

          <section className="card stack">
            <h2>4. {s.wizard.step4}</h2>
            {lists?.kind === 'loading' ? <Loading text={s.wizard.loadingLists} /> : null}
            {lists?.kind === 'error' ? (
              <Notice tone="danger">
                <p>{lists.message}</p>
              </Notice>
            ) : null}
            {lists?.kind === 'ready'
              ? ready.tabs
                  .filter((tab) => tabs.includes(tab.sheetId))
                  .map((tab) => (
                    <div className="field" key={tab.sheetId}>
                      <label htmlFor={`list-${tab.sheetId}`}>{s.wizard.listFor(tab.title)}</label>
                      <select
                        id={`list-${tab.sheetId}`}
                        className="select"
                        value={listOf[tab.sheetId] ?? ''}
                        onChange={(e) => setListOf((cur) => ({ ...cur, [tab.sheetId]: e.target.value }))}
                      >
                        <option value="">{s.wizard.newList}</option>
                        {lists.data.map((l) => (
                          <option key={l.id} value={String(l.id)} disabled={l.linked}>
                            {l.name} {l.linked ? s.wizard.listLinked : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))
              : null}
            {usesExisting ? (
              <fieldset className="stack-tight station-reference">
                <legend>
                  <strong>{s.wizard.referenceTitle}</strong>
                </legend>
                <p className="muted small">{s.wizard.referenceHint}</p>
                {(['merge', 'file', 'basecamp'] as const).map((r) => (
                  <label key={r} className="station-tab">
                    <input type="radio" name="reference" value={r} checked={reference === r} onChange={() => setReference(r)} />
                    <span>
                      <strong>{s.wizard.references[r].label}</strong> <span className="muted small">{s.wizard.references[r].hint}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            ) : null}
            <Notice tone="info">
              <p>{s.wizard.firstSync}</p>
            </Notice>
            <div className="card__actions">
              <button type="button" className="button" onClick={() => void showPreview()} disabled={preview?.kind === 'loading' || !projectId || tabs.length === 0}>
                {preview?.kind === 'loading' ? <LoaderCircle className="icon spin" aria-hidden="true" /> : <RefreshCw className="icon" aria-hidden="true" />}
                {preview?.kind === 'loading' ? s.wizard.previewing : s.wizard.preview}
              </button>
            </div>
            {preview?.kind === 'error' ? (
              <Notice tone="danger">
                <p>{preview.message}</p>
              </Notice>
            ) : null}
            {preview?.kind === 'ready' ? (
              <>
                {!previewed ? (
                  <Notice tone="warning">
                    <p>{s.wizard.previewStale}</p>
                  </Notice>
                ) : null}
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        {(['tab', 'matched', 'changed', 'toBasecamp', 'toSheet', 'ignored', 'held'] as const).map((k) => (
                          <th key={k} scope="col">
                            {s.wizard.previewColumns[k]}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.data.tabs.map((t) =>
                        t.ok ? (
                          <tr key={t.sheetId}>
                            <td>
                              <bdi>{t.title}</bdi>
                            </td>
                            <td>{t.matched}</td>
                            <td>{t.changed}</td>
                            <td>{t.toBasecamp}</td>
                            <td>{t.toSheet}</td>
                            <td>{t.ignored}</td>
                            <td>{t.held}</td>
                          </tr>
                        ) : (
                          <tr key={t.sheetId}>
                            <td>
                              <bdi>{t.title}</bdi>
                            </td>
                            <td colSpan={6} className="muted">
                              {t.reason}
                            </td>
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            ) : null}
            {submit.kind === 'error' ? (
              <p className="field-error" role="alert">
                {submit.message}
              </p>
            ) : null}
            <div className="card__actions">
              <button type="button" className="button button--primary" onClick={() => void create()} disabled={submit.kind === 'saving' || !previewed}>
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

  const detail = load.kind === 'ready' ? load.data : null
  return (
    <Page
      user={user}
      title={title}
      screen="station-link"
      back={{ href: '/', label: s.links.title }}
      subtitle={
        detail ? (
          <>
            <span className={`badge badge--${detail.link.state === 'paused' ? 'neutral' : 'success'}`}>{detail.link.state === 'paused' ? s.links.paused : s.links.active}</span>{' '}
            {s.links.lastSync} {s.ago(detail.link.last_sync_at)}
          </>
        ) : undefined
      }
      actions={detail ? <LinkActions link={detail.link} projectUrl={detail.projectUrl} isAdmin={isAdmin} busy={busy} act={act} /> : undefined}
    >
      {load.kind === 'loading' ? <Loading text={s.link.loading} /> : null}
      {load.kind === 'error' ? <Failed message={load.message} retry={reload} /> : null}
      {flash ? (
        <Notice tone={flash.tone}>
          <p>{flash.text}</p>
        </Notice>
      ) : null}
      {detail ? <LinkBody detail={detail} isAdmin={isAdmin} busy={busy} act={act} /> : null}
    </Page>
  )
}

function LinkActions({
  link,
  projectUrl,
  isAdmin,
  busy,
  act,
}: {
  link: LinkDetail['link']
  projectUrl: string | null
  isAdmin: boolean
  busy: boolean
  act: (fn: () => Promise<unknown>, done?: string) => Promise<void>
}) {
  return (
    <>
      <a className="button button--ghost" href={`https://docs.google.com/spreadsheets/d/${encodeURIComponent(link.spreadsheet_id)}/edit`} target="_blank" rel="noreferrer">
        <ExternalLink className="icon" aria-hidden="true" />
        {s.link.file}
      </a>
      {projectUrl ? (
        <a className="button button--ghost" href={projectUrl} target="_blank" rel="noreferrer">
          <ExternalLink className="icon" aria-hidden="true" />
          {s.link.project}
        </a>
      ) : null}
      {isAdmin ? (
        <>
          <button type="button" className="button button--primary" disabled={busy} onClick={() => void act(() => stationApi.syncNow(link.id), s.link.syncQueued)}>
            <RefreshCw className="icon" aria-hidden="true" />
            {s.link.syncNow}
          </button>
          <button type="button" className="button" disabled={busy} onClick={() => void act(() => stationApi.updateLink(link.id, { state: link.state === 'paused' ? 'active' : 'paused' }))}>
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
    </>
  )
}

type LinkTab = 'problems' | 'tabs' | 'history' | 'deleted'

interface ConflictDetail {
  field: string
  localValue: unknown
  remoteValue: unknown
  winner: 'local' | 'remote'
  restoredAt?: string
}

/** A conflict's losing value, as the sheet would show it. */
function lostValue(c: ConflictDetail): string {
  const v = c.winner === 'local' ? c.remoteValue : c.localValue
  if (c.field === 'completed') return s.link.doneValue(v === true)
  return typeof v === 'string' && v !== '' ? v : s.link.emptyValue
}

function conflictOf(detailJson: string | null): ConflictDetail | null {
  if (!detailJson) return null
  try {
    return JSON.parse(detailJson) as ConflictDetail
  } catch {
    return null
  }
}

function LinkBody({ detail, isAdmin, busy, act }: { detail: LinkDetail; isAdmin: boolean; busy: boolean; act: (fn: () => Promise<unknown>, done?: string) => Promise<void> }) {
  const { link, tabs, problems, log, deleted } = detail
  const [view, setView] = useState<LinkTab>(problems.length > 0 ? 'problems' : 'tabs')
  const views: { id: LinkTab; label: string }[] = [
    { id: 'problems', label: s.link.problemsTab(problems.length) },
    { id: 'tabs', label: s.link.tabs },
    { id: 'history', label: s.link.history },
    { id: 'deleted', label: s.link.deletedTab(deleted.filter((d) => !d.restoredAt).length) },
  ]
  return (
    <div className="stack">
      <div className="station-views" role="tablist" aria-label={link.title}>
        {views.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            id={`view-${v.id}`}
            aria-selected={view === v.id}
            aria-controls={`panel-${v.id}`}
            className={view === v.id ? 'station-views__tab station-views__tab--active' : 'station-views__tab'}
            onClick={() => setView(v.id)}
          >
            {v.label}
          </button>
        ))}
      </div>

      {view === 'problems' ? (
        <section className="stack" role="tabpanel" id="panel-problems" aria-labelledby="view-problems" data-testid="link-problems">
          {problems.length === 0 ? (
            <div className="card">
              <p className="muted">{s.link.noProblems}</p>
            </div>
          ) : (
            problemGroups(problems).map((g) => (
              <section key={g.tab} className="card stack">
                <h2>
                  <bdi>{g.tab}</bdi> <span className="muted small">({s.link.problemsCount(g.items.length)})</span>
                </h2>
                <ul className="station-problems">
                  {g.items.map((p) => (
                    <ProblemItem key={p.key} problem={p} />
                  ))}
                </ul>
              </section>
            ))
          )}
        </section>
      ) : null}

      {view === 'tabs' ? (
        <section className="card stack" role="tabpanel" id="panel-tabs" aria-labelledby="view-tabs">
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
      ) : null}

      {view === 'history' ? (
        <section className="card stack" role="tabpanel" id="panel-history" aria-labelledby="view-history">
          {log.length === 0 ? <p className="muted">{s.link.noHistory}</p> : null}
          <div className="table-wrap">
            <table className="data-table">
              <tbody>
                {log.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <bdi dir="ltr">{s.date(l.at)}</bdi>
                    </td>
                    <td>{l.direction === 'to_sheet' ? s.link.toSheet : s.link.toBasecamp}</td>
                    <td>
                      {s.link.actions[l.action] ?? l.action}
                      {l.action === 'conflict' ? <ConflictLine linkId={link.id} logId={l.id} conflict={conflictOf(l.detail_json)} isAdmin={isAdmin} busy={busy} act={act} /> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      {view === 'deleted' ? <DeletedPanel linkId={link.id} deleted={deleted} isAdmin={isAdmin} busy={busy} act={act} /> : null}
    </div>
  )
}

function ConflictLine({
  linkId,
  logId,
  conflict,
  isAdmin,
  busy,
  act,
}: {
  linkId: string
  logId: number
  conflict: ConflictDetail | null
  isAdmin: boolean
  busy: boolean
  act: (fn: () => Promise<unknown>, done?: string) => Promise<void>
}) {
  if (!conflict) return null
  const field = s.link.conflictField[conflict.field]
  return (
    <div className="row-actions small">
      <span className="muted">{field ? s.link.conflictLost(field, lostValue(conflict)) : null}</span>
      {conflict.restoredAt ? (
        <span className="badge badge--neutral">{s.link.valueRestored}</span>
      ) : isAdmin && field ? (
        <button type="button" className="button button--small button--ghost" disabled={busy} onClick={() => void act(() => stationApi.restoreConflict(linkId, logId), s.link.restoreValueDone)}>
          <RotateCcw className="icon" aria-hidden="true" />
          {s.link.restoreValue}
        </button>
      ) : null}
    </div>
  )
}

function DeletedPanel({
  linkId,
  deleted,
  isAdmin,
  busy,
  act,
}: {
  linkId: string
  deleted: LinkDetail['deleted']
  isAdmin: boolean
  busy: boolean
  act: (fn: () => Promise<unknown>, done?: string) => Promise<void>
}) {
  return (
    <section className="card stack" role="tabpanel" id="panel-deleted" aria-labelledby="view-deleted">
      <p className="muted small">{s.link.deletedLead}</p>
      {deleted.length === 0 ? <p className="muted">{s.link.noDeleted}</p> : null}
      {deleted.length > 0 ? (
        <div className="table-wrap">
          <table className="data-table">
            <tbody>
              {deleted.map((d) => (
                <tr key={d.id}>
                  <td>
                    <strong>
                      <bdi>{d.title}</bdi>
                    </strong>
                  </td>
                  <td className="muted small">
                    {s.link.deletedAt} <bdi dir="ltr">{s.date(d.deletedAt)}</bdi>
                  </td>
                  <td>
                    {d.restoredAt ? (
                      <span className="badge badge--neutral">{s.link.restored}</span>
                    ) : isAdmin ? (
                      <button type="button" className="button button--small" disabled={busy} onClick={() => void act(() => stationApi.restoreDeleted(linkId, d.id), s.link.restoreDone)}>
                        <RotateCcw className="icon" aria-hidden="true" />
                        {s.link.restore}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  )
}

type Problem = LinkDetail['problems'][number]

/** Problems by sheet tab (the file-wide ones first), in a stable order. */
export function problemGroups(problems: readonly Problem[]): { tab: string; items: Problem[] }[] {
  const order: Record<StationAlert['kind'], number> = { link_stopped: 0, tab_stopped: 1, name_unmapped: 2, not_project_member: 3, roles_conflict: 4, rows_held: 5 }
  const tabOf = (a: StationAlert): string => ('tab' in a ? a.tab : s.link.wholeFile)
  const groups = new Map<string, Problem[]>()
  for (const p of [...problems].sort((x, y) => order[x.alert.kind] - order[y.alert.kind] || x.firstSeen.localeCompare(y.firstSeen))) {
    const tab = tabOf(p.alert)
    groups.set(tab, [...(groups.get(tab) ?? []), p])
  }
  return [...groups].sort(([a], [b]) => (a === s.link.wholeFile ? -1 : b === s.link.wholeFile ? 1 : a.localeCompare(b, 'ar'))).map(([tab, items]) => ({ tab, items }))
}

function ProblemItem({ problem }: { problem: Problem }) {
  const a = problem.alert
  const rowNumbers = a.kind === 'rows_held' || a.kind === 'name_unmapped' ? a.rowNumbers : undefined
  return (
    <li className="station-problem">
      <p className="station-problem__title">{problemTitle(a)}</p>
      <p>{problemDetail(a)}</p>
      {rowNumbers && rowNumbers.length > 0 ? (
        <p className="station-problem__rows small">
          <span className="muted">{rowNumbers.length === 1 ? s.link.row : s.link.rows}</span>
          {rowNumbers.map((n) => (
            <span key={n} className="badge badge--neutral num">
              {n}
            </span>
          ))}
        </p>
      ) : null}
      <p className="muted small">
        {s.link.since} <bdi dir="ltr">{s.date(problem.firstSeen)}</bdi>
        {problem.emailedAt ? ` · ${s.link.emailed}` : ''}
      </p>
      {a.kind === 'name_unmapped' ? (
        <Link className="button button--small" href={`/names?name=${encodeURIComponent(a.name)}`}>
          {s.alert.linkName}
        </Link>
      ) : null}
    </li>
  )
}

function problemTitle(a: StationAlert): string {
  switch (a.kind) {
    case 'name_unmapped':
      return s.problem.nameUnmapped(a.name)
    case 'not_project_member':
      return s.problem.notMember(a.personName)
    case 'roles_conflict':
      return s.problem.rolesConflict(a.role)
    case 'rows_held':
      return s.problem.held[a.code] ?? s.problem.heldDefault
    case 'tab_stopped':
      return s.problem.tabStopped
    case 'link_stopped':
      return s.problem.linkStopped
  }
}

function problemDetail(a: StationAlert): string {
  switch (a.kind) {
    case 'name_unmapped':
      return s.problem.nameUnmappedDetail(a.role, a.rows)
    case 'not_project_member':
      return s.problem.notMemberDetail(a.projectName, a.rows)
    case 'roles_conflict':
      return s.problem.rolesConflictDetail(a.names)
    default:
      return a.reason
  }
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
    <Page user={user} title={s.names.title} screen="station-names" subtitle={s.names.lead}>
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
                {isAdmin ? <th scope="col"><span className="sr-only">{s.names.remove}</span></th> : null}
              </tr>
            </thead>
            <tbody>
              {data.names.map((n) => (
                <tr key={n.name}>
                  <td>
                    <strong>
                      <bdi>{n.name}</bdi>
                    </strong>
                  </td>
                  <td>
                    <bdi>{personName.get(n.bc_person_id) ?? n.bc_person_id}</bdi>
                  </td>
                  <td>
                    <span className="badge badge--neutral">{n.source === 'auto' ? s.names.auto : s.names.manual}</span>
                  </td>
                  {isAdmin ? (
                    <td>
                      <UnmapButton name={n.name} onDone={reload} />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function UnmapButton({ name, onDone }: { name: string; onDone: () => void }) {
  const [status, setStatus] = useState<{ kind: 'idle' | 'removing' } | { kind: 'error'; message: string }>({ kind: 'idle' })
  const remove = async () => {
    if (!window.confirm(s.names.removeConfirm(name))) return
    setStatus({ kind: 'removing' })
    try {
      await stationApi.deleteName(name)
      onDone()
    } catch (error) {
      setStatus({ kind: 'error', message: errorMessage(error) })
    }
  }
  return (
    <div className="row-actions">
      <button type="button" className="button button--small button--ghost" data-name={name} disabled={status.kind === 'removing'} onClick={() => void remove()}>
        <Trash2 className="icon" aria-hidden="true" />
        {status.kind === 'removing' ? s.names.removing : s.names.remove}
      </button>
      {status.kind === 'error' ? (
        <span className="field-error" role="alert">
          {status.message}
        </span>
      ) : null}
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
}: {
  name: string
  hint?: string
  suggestion?: string
  initial: string
  people: { id: number; name: string }[]
  isAdmin: boolean
  focus?: boolean
  onSaved: () => void
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
      {isAdmin ? (
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
    </div>
  )
}
