// Add or edit a custom widget: sheet, column or range, aggregation, optional
// group-by column, display — with a live preview computed by the server
// (POST …/dashboard/preview, nothing stored). Opened by editors only; the API
// refuses viewers anyway.

import { useEffect, useId, useRef, useState } from 'react'
import { ChartBar, ChartLine, ChartPie, Donut, Hash, LoaderCircle, Table2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { DashboardDisplay, DashboardSheet, DashboardWidget, WidgetResult } from '@naf-sheets/shared'
import { DASHBOARD_AGGREGATIONS, DASHBOARD_DISPLAYS, WIDGET_TITLE_MAX_LENGTH } from '@naf-sheets/shared'
import { api, errorMessage, isAbortError } from '../lib/api'
import { Notice } from '../components/Notice'
import { t } from '../strings'
import { checkDraft, draftFromWidget, newDraft } from './model'
import type { WidgetDraft } from './model'
import { WidgetFigure } from './WidgetViews'

const td = t.dashboard.dialog

export const DISPLAY_ICONS: Record<DashboardDisplay, LucideIcon> = { kpi: Hash, bar: ChartBar, pie: ChartPie, donut: Donut, line: ChartLine, table: Table2 }

const PREVIEW_DELAY_MS = 350

export function WidgetDialog({
  workbookId,
  sheets,
  widget,
  onClose,
  onSaved,
}: {
  workbookId: string
  sheets: readonly DashboardSheet[]
  /** Null: a new widget. */
  widget: DashboardWidget | null
  onClose: () => void
  onSaved: (widget: DashboardWidget, created: boolean) => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const ids = useId()
  const [draft, setDraft] = useState<WidgetDraft>(() => (widget ? draftFromWidget(widget) : newDraft(sheets)))
  const [preview, setPreview] = useState<{ kind: 'idle' } | { kind: 'loading' } | { kind: 'ready'; result: WidgetResult } | { kind: 'error'; message: string }>({ kind: 'idle' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  const set = <K extends keyof WidgetDraft>(key: K, value: WidgetDraft[K]) => setDraft((d) => ({ ...d, [key]: value }))
  const sheet = sheets.find((s) => s.sheetId === draft.sheetId) ?? null
  const columns = sheet?.columns ?? []

  // The preview follows the form, a moment after the last change.
  const previewCheck = checkDraft(draft, { forPreview: true })
  const previewKey = previewCheck.config ? JSON.stringify(previewCheck.config) : ''
  useEffect(() => {
    if (!previewCheck.config) {
      setPreview({ kind: 'idle' })
      return
    }
    const config = previewCheck.config
    const controller = new AbortController()
    setPreview({ kind: 'loading' })
    const timer = setTimeout(() => {
      api.previewWidget(workbookId, config, controller.signal).then(
        (result) => setPreview({ kind: 'ready', result }),
        (e: unknown) => {
          if (!isAbortError(e)) setPreview({ kind: 'error', message: errorMessage(e) })
        },
      )
    }, PREVIEW_DELAY_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
    // `previewKey` stands for the configuration.
  }, [previewKey, workbookId])

  const check = checkDraft(draft)
  const problems = touched ? check.problems : check.problems.filter((p) => p !== 'title')

  const submit = async () => {
    setTouched(true)
    if (!check.config) return
    setSaving(true)
    setError(null)
    try {
      const res = widget ? await api.updateWidget(workbookId, widget.id, check.config) : await api.createWidget(workbookId, check.config)
      onSaved(res.widget, widget === null)
    } catch (e) {
      setError(errorMessage(e))
      setSaving(false)
    }
  }

  const changeSheet = (sheetId: string) => {
    const next = sheets.find((s) => s.sheetId === sheetId)
    const keys = new Set((next?.columns ?? []).map((c) => c.key))
    setDraft((d) => ({
      ...d,
      sheetId,
      column: keys.has(d.column) ? d.column : (next?.columns[0]?.key ?? 'A'),
      groupBy: d.groupBy === '' || keys.has(d.groupBy) ? d.groupBy : '',
    }))
  }

  const columnOptions = (current: string) => {
    const list = columns.some((c) => c.key === current) || current === '' ? columns : [...columns, { key: current, header: '' }]
    return list.map((c) => (
      <option key={c.key} value={c.key}>
        {td.columnOption(c.key, c.header)}
      </option>
    ))
  }

  return (
    <dialog ref={ref} className="dialog dialog--wide" aria-labelledby={`${ids}-title`} onClose={onClose} data-testid="widget-dialog">
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <h2 id={`${ids}-title`}>{widget ? td.editTitle : td.addTitle}</h2>
        <div className="widget-form">
          <div className="widget-form__fields">
            <label className="field">
              <span>{td.titleLabel}</span>
              <input
                className="input"
                value={draft.title}
                maxLength={WIDGET_TITLE_MAX_LENGTH}
                placeholder={td.titlePlaceholder}
                onChange={(e) => set('title', e.target.value)}
                onBlur={() => setTouched(true)}
                aria-invalid={problems.includes('title')}
                aria-describedby={problems.includes('title') ? `${ids}-title-error` : undefined}
                data-testid="widget-title"
                autoFocus
              />
              {problems.includes('title') ? (
                <span className="field-error" id={`${ids}-title-error`}>
                  {td.titleRequired}
                </span>
              ) : null}
            </label>

            <label className="field">
              <span>{td.sheet}</span>
              {sheets.length === 0 ? (
                <span className="muted">{td.noSheets}</span>
              ) : (
                <select className="select" value={draft.sheetId} onChange={(e) => changeSheet(e.target.value)} data-testid="widget-sheet">
                  {sheets.map((s) => (
                    <option key={s.sheetId} value={s.sheetId}>
                      {s.title}
                    </option>
                  ))}
                </select>
              )}
            </label>

            <fieldset className="field-group">
              <legend>{td.source}</legend>
              <div className="segmented" role="radiogroup">
                {(['column', 'range'] as const).map((kind) => (
                  <label key={kind} className="segmented__option">
                    <input type="radio" name={`${ids}-source`} value={kind} checked={draft.sourceKind === kind} onChange={() => set('sourceKind', kind)} data-testid={`widget-source-${kind}`} />
                    <span>{kind === 'column' ? td.sourceColumn : td.sourceRange}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            {draft.sourceKind === 'column' ? (
              <label className="field">
                <span>{td.column}</span>
                <select className="select" value={draft.column} onChange={(e) => set('column', e.target.value)} data-testid="widget-column">
                  {columnOptions(draft.column)}
                </select>
              </label>
            ) : (
              <label className="field">
                <span>{td.range}</span>
                <input
                  className="input input--latin"
                  dir="ltr"
                  value={draft.range}
                  placeholder={td.rangePlaceholder}
                  onChange={(e) => set('range', e.target.value.toUpperCase())}
                  aria-invalid={problems.includes('range') && draft.range !== ''}
                  aria-describedby={`${ids}-range-hint`}
                  data-testid="widget-range"
                />
                <span className={problems.includes('range') && draft.range !== '' ? 'field-error' : 'field-hint'} id={`${ids}-range-hint`}>
                  {problems.includes('range') && draft.range !== '' ? td.rangeInvalid : td.rangeHint}
                </span>
              </label>
            )}

            <label className="field">
              <span>{td.aggregation}</span>
              <select className="select" value={draft.aggregation} onChange={(e) => set('aggregation', e.target.value as WidgetDraft['aggregation'])} data-testid="widget-aggregation">
                {DASHBOARD_AGGREGATIONS.map((a) => (
                  <option key={a} value={a}>
                    {t.dashboard.aggregation[a]}
                  </option>
                ))}
              </select>
              <span className="field-hint">{t.dashboard.aggregationHint[draft.aggregation]}</span>
            </label>

            <label className="field">
              <span>{td.groupBy}</span>
              <select className="select" value={draft.groupBy} onChange={(e) => set('groupBy', e.target.value)} data-testid="widget-group">
                <option value="">{td.noGroup}</option>
                {columnOptions(draft.groupBy)}
              </select>
            </label>

            <fieldset className="field-group">
              <legend>{td.display}</legend>
              <div className="display-picker" role="radiogroup">
                {DASHBOARD_DISPLAYS.map((d) => {
                  const Icon = DISPLAY_ICONS[d]
                  return (
                    <label key={d} className="display-picker__option">
                      <input type="radio" name={`${ids}-display`} value={d} checked={draft.display === d} onChange={() => set('display', d)} data-testid={`widget-display-${d}`} />
                      <Icon className="icon" aria-hidden="true" />
                      <span>{t.dashboard.display[d]}</span>
                    </label>
                  )
                })}
              </div>
              {problems.includes('group') ? (
                <span className="field-error" role="status">
                  {td.needsGroup}
                </span>
              ) : null}
            </fieldset>
          </div>

          <section className="widget-form__preview" aria-labelledby={`${ids}-preview`} data-testid="widget-preview">
            <h3 id={`${ids}-preview`}>{td.preview}</h3>
            <div className="widget widget--preview" aria-live="polite">
              <p className="widget__title">
                <bdi>{draft.title.trim() || td.titlePlaceholder}</bdi>
              </p>
              {preview.kind === 'idle' ? <p className="muted">{td.previewIdle}</p> : null}
              {preview.kind === 'loading' ? (
                <p className="muted with-icon" role="status">
                  <LoaderCircle className="icon spin" aria-hidden="true" />
                  {td.previewLoading}
                </p>
              ) : null}
              {preview.kind === 'error' ? <p className="field-error">{preview.message}</p> : null}
              {preview.kind === 'ready' && previewCheck.config ? (
                <WidgetFigure workbookId={workbookId} title={previewCheck.config.title} result={preview.result} display={draft.display} aggregation={draft.aggregation} />
              ) : null}
            </div>
          </section>
        </div>

        {error ? (
          <Notice tone="danger" testId="widget-save-error">
            <p>{error}</p>
          </Notice>
        ) : null}

        <div className="dialog__actions">
          <button type="submit" className="button button--primary" disabled={saving} data-testid="widget-save">
            {saving ? <LoaderCircle className="icon spin" aria-hidden="true" /> : null}
            {saving ? td.saving : widget ? td.save : td.add}
          </button>
          <button type="button" className="button" onClick={() => ref.current?.close()} disabled={saving}>
            {td.cancel}
          </button>
        </div>
      </form>
    </dialog>
  )
}

/** «إزالة العنصر من اللوحة؟» — the confirmation the API also requires (`confirmed: true`). */
export function RemoveWidgetDialog({ widget, onDecide, busy, error }: { widget: DashboardWidget; onDecide: (confirmed: boolean) => void; busy: boolean; error: string | null }) {
  const ref = useRef<HTMLDialogElement>(null)
  const ids = useId()
  useEffect(() => {
    ref.current?.showModal()
  }, [])
  return (
    <dialog ref={ref} className="dialog" role="alertdialog" aria-labelledby={`${ids}-title`} aria-describedby={`${ids}-body`} onClose={() => onDecide(false)} data-testid="widget-remove-dialog">
      <div className="dialog__body">
        <h2 id={`${ids}-title`}>{t.dashboard.remove.title}</h2>
        <p id={`${ids}-body`}>{t.dashboard.remove.body(widget.title)}</p>
        {error ? (
          <Notice tone="danger">
            <p>{error}</p>
          </Notice>
        ) : null}
        <div className="dialog__actions">
          <button type="button" className="button button--danger" onClick={() => onDecide(true)} disabled={busy} data-testid="widget-remove-confirm">
            {busy ? <LoaderCircle className="icon spin" aria-hidden="true" /> : null}
            {t.dashboard.remove.confirm}
          </button>
          <button type="button" className="button" onClick={() => ref.current?.close()} disabled={busy} autoFocus>
            {t.dashboard.remove.cancel}
          </button>
        </div>
      </div>
    </dialog>
  )
}
