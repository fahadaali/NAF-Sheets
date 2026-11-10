// Admin: templates (spec §7.1 option 2 «قوالب يحفظها admin (أي ملف يُحوَّل إلى
// قالب)», §12.1 item 8 «الإعدادات العامة: … القوالب»).
// GET /api/templates, POST /api/admin/templates, PUT /api/admin/templates/:id,
// POST /api/admin/templates/:id/archive. Archiving never deletes anything.

import { useEffect, useId, useState } from 'react'
import type { FormEvent } from 'react'
import { Archive, LayoutTemplate, LoaderCircle, Pencil } from 'lucide-react'
import type { CurrentUser, TemplateSummary, WorkbookSummary } from '@naf-sheets/shared'
import { AdminPage } from '../components/AdminPage'
import { Notice } from '../components/Notice'
import { api, errorMessage, isAbortError } from '../lib/api'
import { formatCount, formatDateTime } from '../lib/format'
import { t } from '../strings'

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; templates: TemplateSummary[]; workbooks: WorkbookSummary[] }

export function TemplatesScreen({ user, userSettled }: { user: CurrentUser | null; userSettled: boolean }) {
  return (
    <AdminPage user={user} userSettled={userSettled} title={t.templates.title} screen="templates">
      <Templates />
    </AdminPage>
  )
}

function Templates() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([api.listTemplates(controller.signal), api.listWorkbooks('', controller.signal)]).then(
      ([templates, workbooks]) => setLoad({ kind: 'ready', templates: templates.templates, workbooks: workbooks.workbooks }),
      (error: unknown) => {
        if (!isAbortError(error)) setLoad({ kind: 'error', message: errorMessage(error) })
      },
    )
    return () => controller.abort()
  }, [attempt])

  const reload = () => setAttempt((n) => n + 1)

  if (load.kind === 'loading') {
    return (
      <div className="panel panel--plain" role="status">
        <LoaderCircle className="panel__icon spin" aria-hidden="true" />
        <p>{t.templates.loading}</p>
      </div>
    )
  }
  if (load.kind === 'error') {
    return (
      <Notice
        tone="danger"
        testId="templates-error"
        actions={
          <button type="button" className="button button--small" onClick={reload}>
            {t.files.retry}
          </button>
        }
      >
        <p>{load.message}</p>
      </Notice>
    )
  }

  return (
    <div className="stack">
      <p className="lead">{t.templates.intro}</p>
      <CreateTemplate workbooks={load.workbooks} onCreated={reload} />
      {load.templates.length === 0 ? (
        <section className="panel" data-testid="templates-empty">
          <LayoutTemplate className="panel__icon" aria-hidden="true" />
          <h2>{t.templates.emptyTitle}</h2>
          <p>{t.templates.emptyBody}</p>
        </section>
      ) : (
        <div className="table-wrap">
          <table className="data-table" data-testid="templates-table">
            <caption className="sr-only">{t.templates.title}</caption>
            <thead>
              <tr>
                <th scope="col">{t.templates.columns.title}</th>
                <th scope="col">{t.templates.columns.sheets}</th>
                <th scope="col">{t.templates.columns.source}</th>
                <th scope="col">{t.templates.columns.updatedAt}</th>
                <th scope="col">{t.templates.columns.actions}</th>
              </tr>
            </thead>
            <tbody>
              {load.templates.map((tpl) => (
                <TemplateRow key={tpl.id} template={tpl} onChanged={reload} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function CreateTemplate({ workbooks, onCreated }: { workbooks: WorkbookSummary[]; onCreated: () => void }) {
  const ids = useId()
  const [workbookId, setWorkbookId] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setDone(false)
    if (!workbookId) return setError(t.templates.sourceRequired)
    if (!title.trim()) return setError(t.templates.titleRequired)
    setBusy(true)
    setError(null)
    try {
      await api.createTemplate({ workbookId, title: title.trim(), description: description.trim() || null })
      setWorkbookId('')
      setTitle('')
      setDescription('')
      setDone(true)
      onCreated()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card" aria-labelledby={`${ids}-heading`} data-testid="template-create">
      <h2 id={`${ids}-heading`}>{t.templates.createTitle}</h2>
      {workbooks.length === 0 ? (
        <p className="muted">{t.templates.noWorkbooks}</p>
      ) : (
        <form className="stack" onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor={`${ids}-source`}>{t.templates.sourceLabel}</label>
            <select
              id={`${ids}-source`}
              className="select"
              value={workbookId}
              onChange={(e) => {
                setWorkbookId(e.target.value)
                const picked = workbooks.find((w) => w.id === e.target.value)
                if (picked && !title.trim()) setTitle(picked.title)
              }}
              disabled={busy}
            >
              <option value="">{t.templates.sourcePlaceholder}</option>
              {workbooks.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.title}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${ids}-title`}>{t.templates.titleLabel}</label>
            <input id={`${ids}-title`} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoComplete="off" disabled={busy} />
          </div>
          <div className="field">
            <label htmlFor={`${ids}-description`}>{t.templates.descriptionLabel}</label>
            <textarea id={`${ids}-description`} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} rows={2} disabled={busy} />
          </div>
          {error ? (
            <p className="field-error" role="alert" data-testid="template-create-error">
              {error}
            </p>
          ) : null}
          {done ? (
            <p className="muted" role="status" data-testid="template-created">
              {t.templates.created}
            </p>
          ) : null}
          <div className="card__actions">
            <button type="submit" className="button button--primary" disabled={busy}>
              {busy ? <LoaderCircle className="icon spin" aria-hidden="true" /> : <LayoutTemplate className="icon" aria-hidden="true" />}
              {busy ? t.templates.creating : t.templates.create}
            </button>
          </div>
        </form>
      )}
    </section>
  )
}

type RowMode = { kind: 'view' } | { kind: 'edit' } | { kind: 'confirmArchive' }

function TemplateRow({ template, onChanged }: { template: TemplateSummary; onChanged: () => void }) {
  const ids = useId()
  const [mode, setMode] = useState<RowMode>({ kind: 'view' })
  const [title, setTitle] = useState(template.title)
  const [description, setDescription] = useState(template.description ?? '')
  const [busy, setBusy] = useState<null | 'saving' | 'archiving'>(null)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    if (!title.trim()) return setError(t.templates.titleRequired)
    setBusy('saving')
    setError(null)
    try {
      await api.updateTemplate(template.id, { title: title.trim(), description: description.trim() || null })
      setMode({ kind: 'view' })
      onChanged()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const archive = async () => {
    setBusy('archiving')
    setError(null)
    try {
      await api.archiveTemplate(template.id)
      onChanged()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(null)
    }
  }

  return (
    <tr data-template-id={template.id}>
      <th scope="row">
        {mode.kind === 'edit' ? (
          <div className="stack-tight">
            <div className="field">
              <label htmlFor={`${ids}-title`} className="sr-only">
                {t.templates.titleLabel}
              </label>
              <input id={`${ids}-title`} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} disabled={busy !== null} />
            </div>
            <div className="field">
              <label htmlFor={`${ids}-description`} className="sr-only">
                {t.templates.descriptionLabel}
              </label>
              <textarea id={`${ids}-description`} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} rows={2} disabled={busy !== null} />
            </div>
          </div>
        ) : (
          <div className="stack-tight">
            <bdi>{template.title}</bdi>
            {template.description ? <span className="muted small">{template.description}</span> : null}
          </div>
        )}
      </th>
      <td>
        <bdi className="num">{formatCount(template.sheetCount)}</bdi>
      </td>
      <td>{template.sourceTitle ? <bdi>{template.sourceTitle}</bdi> : <span className="muted">{t.templates.sourceGone}</span>}</td>
      <td>
        <bdi dir="ltr" className="num">{formatDateTime(template.updatedAt) ?? template.updatedAt}</bdi>
      </td>
      <td>
        <div className="stack-tight">
          {mode.kind === 'view' ? (
            <div className="row-actions">
              <button type="button" className="button button--small" onClick={() => setMode({ kind: 'edit' })}>
                <Pencil className="icon" aria-hidden="true" />
                {t.templates.rename}
              </button>
              <button type="button" className="button button--small" onClick={() => setMode({ kind: 'confirmArchive' })}>
                <Archive className="icon" aria-hidden="true" />
                {t.templates.archive}
              </button>
            </div>
          ) : mode.kind === 'edit' ? (
            <div className="row-actions">
              <button type="button" className="button button--small button--primary" onClick={() => void save()} disabled={busy !== null}>
                {busy === 'saving' ? <LoaderCircle className="icon spin" aria-hidden="true" /> : null}
                {busy === 'saving' ? t.templates.saving : t.templates.save}
              </button>
              <button
                type="button"
                className="button button--small"
                onClick={() => {
                  setTitle(template.title)
                  setDescription(template.description ?? '')
                  setError(null)
                  setMode({ kind: 'view' })
                }}
                disabled={busy !== null}
              >
                {t.templates.cancel}
              </button>
            </div>
          ) : (
            <div className="stack-tight" role="group" aria-label={t.templates.archive}>
              <p className="small">{t.templates.archiveConfirm}</p>
              <div className="row-actions">
                <button type="button" className="button button--small button--danger" onClick={() => void archive()} disabled={busy !== null}>
                  {busy === 'archiving' ? <LoaderCircle className="icon spin" aria-hidden="true" /> : <Archive className="icon" aria-hidden="true" />}
                  {busy === 'archiving' ? t.templates.archiving : t.templates.archiveYes}
                </button>
                <button type="button" className="button button--small" onClick={() => setMode({ kind: 'view' })} disabled={busy !== null}>
                  {t.templates.cancel}
                </button>
              </div>
            </div>
          )}
          {error ? (
            <span className="field-error" role="alert">
              {error}
            </span>
          ) : null}
        </div>
      </td>
    </tr>
  )
}
