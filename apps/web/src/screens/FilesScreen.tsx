// Files screen (spec §12.1 item 1): every workbook the caller can open, with
// title, linked project, sheet count, completion, last update and sync state;
// search; «ملف جديد».

import { useEffect, useState } from 'react'
import { Eye, FileSpreadsheet, LoaderCircle, Plus, Search, SearchX } from 'lucide-react'
import type { CurrentUser, WorkbookSummary } from '@naf-sheets/shared'
import { api, errorMessage, isAbortError } from '../lib/api'
import { formatCount, formatDateTime, formatPercent } from '../lib/format'
import { Link, navigate } from '../lib/router'
import { pathFor } from '../lib/routes'
import { useDocumentTitle } from '../lib/use-document-title'
import { AppBar } from '../components/AppBar'
import { Notice } from '../components/Notice'
import { SyncBadge } from '../components/SyncBadge'
import { NewWorkbookDialog } from './NewWorkbookDialog'
import { t } from '../strings'

const SEARCH_DEBOUNCE_MS = 300

type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; workbooks: WorkbookSummary[]; q: string }

export function FilesScreen({ initialQuery, user }: { initialQuery: string; user: CurrentUser | null }) {
  useDocumentTitle(t.files.title)
  const [query, setQuery] = useState(initialQuery)
  const [effectiveQuery, setEffectiveQuery] = useState(initialQuery.trim())
  const [list, setList] = useState<ListState>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [creating, setCreating] = useState(false)
  // Platform viewers are read-only everywhere (spec §3); the API enforces it too.
  const canCreate = user?.role !== 'viewer'

  useEffect(() => {
    const handle = setTimeout(() => setEffectiveQuery(query.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [query])

  // Keep the search in the address so Back returns to the same list.
  useEffect(() => {
    navigate(pathFor({ name: 'files', q: effectiveQuery }), { replace: true })
  }, [effectiveQuery])

  useEffect(() => {
    const controller = new AbortController()
    setList((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }))
    api.listWorkbooks(effectiveQuery, controller.signal).then(
      (res) => setList({ kind: 'ready', workbooks: res.workbooks, q: effectiveQuery }),
      (error: unknown) => {
        if (!isAbortError(error)) setList({ kind: 'error', message: errorMessage(error) })
      },
    )
    return () => controller.abort()
  }, [effectiveQuery, attempt])

  const openCreate = () => setCreating(true)

  return (
    <>
      <a className="skip-link" href="#main">
        {t.skipToContent}
      </a>
      <AppBar user={user} />
      <main id="main" className="page" data-screen="files">
        <div className="page-head">
          <h1>{t.files.title}</h1>
          {list.kind === 'ready' && list.workbooks.length > 0 ? <span className="muted">{t.files.count(list.workbooks.length)}</span> : null}
        </div>

        <div className="toolbar">
          <div className="search" role="search">
            <Search className="icon" aria-hidden="true" />
            <label htmlFor="files-search" className="sr-only">
              {t.files.searchLabel}
            </label>
            <input
              id="files-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t.files.searchPlaceholder}
              autoComplete="off"
            />
          </div>
          {canCreate ? (
            <button type="button" className="button button--primary" onClick={openCreate}>
              <Plus className="icon" aria-hidden="true" />
              {t.files.newFile}
            </button>
          ) : null}
        </div>

        <FilesContent
          list={list}
          canCreate={canCreate}
          onCreate={openCreate}
          onRetry={() => setAttempt((n) => n + 1)}
          onClearSearch={() => {
            setQuery('')
            setEffectiveQuery('')
          }}
        />
      </main>
      <NewWorkbookDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false)
          navigate(pathFor({ name: 'editor', id }))
        }}
      />
    </>
  )
}

function FilesContent({
  list,
  canCreate,
  onCreate,
  onRetry,
  onClearSearch,
}: {
  list: ListState
  canCreate: boolean
  onCreate: () => void
  onRetry: () => void
  onClearSearch: () => void
}) {
  if (list.kind === 'loading') {
    return (
      <div className="panel panel--plain" role="status">
        <LoaderCircle className="panel__icon spin" aria-hidden="true" />
        <p>{t.files.loading}</p>
      </div>
    )
  }
  if (list.kind === 'error') {
    return (
      <Notice
        tone="danger"
        testId="files-error"
        actions={
          <button type="button" className="button button--small" onClick={onRetry}>
            {t.files.retry}
          </button>
        }
      >
        <p>{list.message}</p>
      </Notice>
    )
  }
  if (list.workbooks.length === 0 && list.q) {
    return (
      <section className="panel" data-testid="files-no-matches">
        <SearchX className="panel__icon" aria-hidden="true" />
        <h2>{t.files.noMatchesTitle}</h2>
        <p>{t.files.noMatchesBody}</p>
        <button type="button" className="button" onClick={onClearSearch}>
          {t.files.clearSearch}
        </button>
      </section>
    )
  }
  if (list.workbooks.length === 0) {
    return (
      <section className="panel" data-testid="files-empty">
        <FileSpreadsheet className="panel__icon" aria-hidden="true" />
        <h2>{canCreate ? t.files.emptyTitle : t.files.emptyViewerTitle}</h2>
        <p>{canCreate ? t.files.emptyBody : t.files.emptyViewerBody}</p>
        {canCreate ? (
          <button type="button" className="button button--primary" onClick={onCreate}>
            <Plus className="icon" aria-hidden="true" />
            {t.files.newFile}
          </button>
        ) : null}
      </section>
    )
  }
  return (
    <div className="table-wrap">
      <table className="files-table">
        <caption className="sr-only">{t.files.title}</caption>
        <thead>
          <tr>
            <th scope="col">{t.files.columns.title}</th>
            <th scope="col" className="col-wide">
              {t.files.columns.project}
            </th>
            <th scope="col" className="col-wide">
              {t.files.columns.sheets}
            </th>
            <th scope="col">{t.files.columns.completion}</th>
            <th scope="col" className="col-wide">
              {t.files.columns.updatedAt}
            </th>
            <th scope="col">{t.files.columns.sync}</th>
          </tr>
        </thead>
        <tbody>
          {list.workbooks.map((w) => (
            <WorkbookRow key={w.id} workbook={w} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function WorkbookRow({ workbook: w }: { workbook: WorkbookSummary }) {
  const updated = formatDateTime(w.updatedAt)
  return (
    <tr data-workbook-id={w.id}>
      <td>
        <div className="title-cell">
          <Link href={pathFor({ name: 'editor', id: w.id })} className="file-link">
            <FileSpreadsheet className="icon" aria-hidden="true" />
            <bdi>{w.title}</bdi>
          </Link>
          {w.access === 'viewer' ? (
            <span className="badge badge--neutral">
              <Eye className="icon" aria-hidden="true" />
              {t.files.readOnly}
            </span>
          ) : null}
        </div>
      </td>
      <td className="col-wide">
        {/* OPEN: the contract carries the Basecamp project id only, not its name. */}
        {w.bcProjectId === null ? (
          <span className="muted">{t.files.noProject}</span>
        ) : (
          <span>
            {t.files.projectNumber} <bdi className="num">{w.bcProjectId}</bdi>
          </span>
        )}
      </td>
      <td className="col-wide">
        <bdi className="num">{formatCount(w.sheetCount)}</bdi>
      </td>
      <td>
        <Completion share={w.completion} />
      </td>
      <td className="col-wide">
        {updated ? (
          <bdi dir="ltr" className="num">
            {updated}
          </bdi>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td>
        <SyncBadge state={w.syncState} />
      </td>
    </tr>
  )
}

function Completion({ share }: { share: number | null }) {
  const percent = formatPercent(share)
  if (percent === null) return <span className="muted">{t.files.noCompletion}</span>
  return (
    <span className="progress">
      <span className="progress__track" aria-hidden="true">
        <span className="progress__fill" style={{ display: 'block', inlineSize: percent }} />
      </span>
      <bdi dir="ltr" className="num">
        {percent}
      </bdi>
    </span>
  )
}
