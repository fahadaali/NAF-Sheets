// The workbook dashboard («اللوحة»): a layer that only reflects the
// workbook's content. It never edits a cell. Every figure and chart element
// links to its cells (the editor's `?sheet=&range=` deep link).
//
// Data: GET /api/workbooks/:id/dashboard, computed by the server from the
// latest committed snapshot. Refreshed when the room reports a commit or a
// fallback save lands (`refreshKey`), when the dashboard is shown again, and
// every POLL_MS as a fallback.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Activity,
  ArrowDown,
  ArrowUp,
  CalendarClock,
  CalendarX2,
  ChartColumnStacked,
  CircleCheck,
  CircleDot,
  CloudDownload,
  CloudUpload,
  LayoutDashboard,
  ListChecks,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Sheet,
  Trash2,
  TriangleExclamationPoint,
  UserRoundX,
  Users,
  Building2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { CellLink, DashboardResponse, DashboardTask, DashboardTaskStatus, DashboardWidget } from '@naf-sheets/shared'
import { api, errorMessage, isAbortError } from '../lib/api'
import { formatDateTime } from '../lib/format'
import { Link, navigate } from '../lib/router'
import { pathFor } from '../lib/routes'
import { Notice } from '../components/Notice'
import { SyncBadge } from '../components/SyncBadge'
import { t } from '../strings'
import { Columns, HorizontalBars, useChartTokens } from './charts'
import type { BarRow, SeriesSpec } from './charts'
import { activityLabel, cellsHref, formatNumber, formatShare, moveWidget } from './model'
import { WidgetDialog, RemoveWidgetDialog } from './WidgetDialog'
import { WidgetFigure } from './WidgetViews'

const td = t.dashboard

/** Fallback refresh while the dashboard is shown (the room's commits refresh it sooner). */
export const POLL_MS = 30_000
/** A burst of commits refreshes once. */
const REFRESH_DELAY_MS = 600
/** People drawn in the chart; the list under it has everyone. */
const PEOPLE_IN_CHART = 8

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: DashboardResponse; at: string }

const STATUS_ICON: Record<DashboardTaskStatus, LucideIcon> = { done: CircleCheck, open: CircleDot, overdue: CalendarX2 }

export function DashboardView({
  workbookId,
  visible,
  refreshKey,
}: {
  workbookId: string
  /** Shown now: refreshes and polls only then. */
  visible: boolean
  /** Changes whenever the workbook was committed (room `saved`, a PUT save). */
  refreshKey: string
}) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<{ widget: DashboardWidget | null } | null>(null)
  const [removal, setRemoval] = useState<{ widget: DashboardWidget; busy: boolean; error: string | null } | null>(null)
  const [announce, setAnnounce] = useState('')
  const controllerRef = useRef<AbortController | null>(null)

  const refresh = useCallback(async () => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setRefreshing(true)
    try {
      const data = await api.getDashboard(workbookId, controller.signal)
      setLoad({ kind: 'ready', data, at: new Date().toISOString() })
      setRefreshError(null)
    } catch (error) {
      if (isAbortError(error)) return
      setLoad((current) => (current.kind === 'ready' ? current : { kind: 'error', message: errorMessage(error) }))
      setRefreshError(errorMessage(error))
    } finally {
      if (controllerRef.current === controller) setRefreshing(false)
    }
  }, [workbookId])

  // Shown (again), or the workbook was committed: refresh (a burst once).
  useEffect(() => {
    if (!visible) return
    const timer = setTimeout(() => void refresh(), load.kind === 'ready' ? REFRESH_DELAY_MS : 0)
    return () => clearTimeout(timer)
    // `load` is read for the delay only.
  }, [visible, refreshKey, refresh])

  // Polling fallback, only while shown and the page is visible.
  useEffect(() => {
    if (!visible) return
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [visible, refresh])

  useEffect(() => () => controllerRef.current?.abort(), [])

  if (load.kind === 'loading') {
    return (
      <div className="dashboard dashboard--message" data-testid="dashboard" data-state="loading">
        <div className="panel panel--plain" role="status">
          <LoaderCircle className="panel__icon spin" aria-hidden="true" />
          <p>{td.loading}</p>
        </div>
      </div>
    )
  }
  if (load.kind === 'error') {
    return (
      <div className="dashboard dashboard--message" data-testid="dashboard" data-state="error">
        <Notice
          tone="danger"
          title={td.loadFailedTitle}
          testId="dashboard-error"
          actions={
            <button type="button" className="button button--small" onClick={() => void refresh()}>
              {td.retry}
            </button>
          }
        >
          <p>{load.message}</p>
        </Notice>
      </div>
    )
  }

  const { data } = load
  const go = (link: CellLink | null) => () => {
    if (link) navigate(cellsHref(workbookId, link))
  }
  const href = (link: CellLink) => cellsHref(workbookId, link)
  const taskSheets = data.sheets.filter((s) => s.kind === 'tasks')

  const setWidgets = (widgets: DashboardWidget[], message: string) => {
    setLoad((current) => (current.kind === 'ready' ? { ...current, data: { ...current.data, widgets } } : current))
    setAnnounce(message)
    void refresh()
  }

  const move = async (index: number, delta: -1 | 1) => {
    const ids = moveWidget(
      data.widgets.map((w) => w.id),
      index,
      delta,
    )
    try {
      const res = await api.reorderWidgets(workbookId, ids)
      setWidgets(res.widgets, td.widgets.moved)
    } catch (error) {
      setRefreshError(errorMessage(error))
    }
  }

  const removeConfirmed = async (widget: DashboardWidget) => {
    setRemoval({ widget, busy: true, error: null })
    try {
      const res = await api.removeWidget(workbookId, widget.id)
      setRemoval(null)
      setWidgets(res.widgets, td.widgets.removed)
    } catch (error) {
      setRemoval({ widget, busy: false, error: errorMessage(error) })
    }
  }

  return (
    <div className="dashboard" data-testid="dashboard" data-state="ready" data-version={data.version}>
      <div className="dashboard__inner">
        <header className="dashboard__head">
          <div className="dashboard__heading">
            <h2 className="with-icon">
              <LayoutDashboard className="icon" aria-hidden="true" />
              {td.title}
            </h2>
            <p className="muted small">{td.lead}</p>
          </div>
          <div className="dashboard__meta">
            <span className="muted small" data-testid="dashboard-updated">
              {td.updatedAt}{' '}
              <bdi dir="ltr" className="num">
                {formatDateTime(load.at)?.slice(11) ?? ''}
              </bdi>
              {' · '}
              {td.live}
            </span>
            <button type="button" className="button button--small" onClick={() => void refresh()} disabled={refreshing} data-testid="dashboard-refresh">
              <RefreshCw className={refreshing ? 'icon spin' : 'icon'} aria-hidden="true" />
              {refreshing ? td.refreshing : td.refresh}
            </button>
          </div>
        </header>
        <p className="sr-only" role="status" aria-live="polite">
          {announce}
        </p>

        {refreshError ? (
          <Notice tone="warning" testId="dashboard-refresh-error">
            <p>{td.refreshFailed}</p>
          </Notice>
        ) : null}

        {/* KPI row */}
        <div className="kpi-row" data-testid="kpi-row">
          <Kpi
            Icon={CircleCheck}
            tone="success"
            label={td.kpi.completion}
            value={formatShare(data.totals.completion)}
            detail={data.totals.todos > 0 ? td.kpi.completionDetail(formatNumber(data.totals.done), formatNumber(data.totals.todos)) : td.kpi.noTasks}
            link={data.totals.completionLink}
            href={href}
            testId="kpi-completion"
            progress={data.totals.completion}
          />
          <Kpi
            Icon={CalendarX2}
            tone={data.totals.overdue > 0 ? 'danger' : 'neutral'}
            label={td.kpi.overdue}
            value={formatNumber(data.totals.overdue)}
            detail={td.kpi.overdueDetail}
            link={data.totals.overdueLink}
            href={href}
            testId="kpi-overdue"
          />
          <Kpi
            Icon={CalendarClock}
            tone="info"
            label={td.kpi.dueThisWeek}
            value={formatNumber(data.totals.dueThisWeek)}
            detail={td.kpi.dueThisWeekDetail}
            link={data.totals.dueThisWeekLink}
            href={href}
            testId="kpi-week"
          />
          <Kpi
            Icon={ListChecks}
            tone="neutral"
            label={td.kpi.subtasks}
            value={data.subtasks.total > 0 ? formatShare(data.subtasks.done / data.subtasks.total) : formatNumber(0)}
            detail={td.kpi.subtasksDetail(formatNumber(data.subtasks.done), formatNumber(data.subtasks.total))}
            link={data.subtasks.link}
            href={href}
            testId="kpi-subtasks"
          />
          <div className="kpi" data-testid="kpi-sync">
            <span className="kpi__label">{td.kpi.sync}</span>
            <span className="kpi__badge">
              <SyncBadge state={data.sync.state} />
            </span>
            <span className="kpi__detail muted">
              {data.sync.state === 'unlinked' ? (
                td.kpi.notLinked
              ) : data.sync.lastSuccessAt ? (
                <>
                  {td.kpi.lastSync}{' '}
                  <bdi dir="ltr" className="num">
                    {formatDateTime(data.sync.lastSuccessAt)}
                  </bdi>
                </>
              ) : (
                td.kpi.neverSynced
              )}
            </span>
          </div>
        </div>

        {taskSheets.length === 0 ? (
          <section className="card dash-empty" data-testid="dashboard-no-tasks">
            <ChartColumnStacked className="panel__icon" aria-hidden="true" />
            <h3>{td.emptyTasksTitle}</h3>
            <p className="muted">{td.emptyTasksBody}</p>
            {data.canEdit ? (
              <div className="card__actions">
                <Link className="button button--small" href={pathFor({ name: 'linkWizard', id: workbookId })}>
                  {td.emptyTasksLink}
                </Link>
                <button type="button" className="button button--small button--primary" onClick={() => setDialog({ widget: null })}>
                  <Plus className="icon" aria-hidden="true" />
                  {td.widgets.add}
                </button>
              </div>
            ) : null}
          </section>
        ) : (
          <div className="dash-grid">
            <SheetsCard data={data} href={href} go={go} />
            <PeopleCard data={data} href={href} go={go} />
            <TimelineCard data={data} href={href} go={go} />
            <SubtasksCard data={data} href={href} />
            <TaskListCard
              title={td.overdue.title}
              Icon={CalendarX2}
              tasks={data.overdue}
              total={data.totals.overdue}
              limit={data.listLimit}
              empty={td.overdue.empty}
              href={href}
              testId="dash-overdue"
            />
            <TaskListCard title={td.week.title} Icon={CalendarClock} tasks={data.dueThisWeek} total={data.totals.dueThisWeek} limit={data.listLimit} empty={td.week.empty} href={href} testId="dash-week" />
            <ActivityCard data={data} href={href} />
          </div>
        )}

        {/* Custom widgets */}
        <section className="dash-widgets" aria-labelledby="dash-widgets-title" data-testid="dash-widgets">
          <div className="section-head dash-widgets__head">
            <div>
              <h3 id="dash-widgets-title">{td.widgets.title}</h3>
              <p className="muted small">{td.widgets.lead}</p>
            </div>
            {data.canEdit && data.widgets.length > 0 ? (
              <button type="button" className="button button--primary button--small" onClick={() => setDialog({ widget: null })} data-testid="widget-add">
                <Plus className="icon" aria-hidden="true" />
                {td.widgets.add}
              </button>
            ) : null}
          </div>
          {!data.canEdit ? (
            <p className="muted small with-icon" data-testid="dashboard-read-only">
              {td.widgets.readOnly}
            </p>
          ) : null}
          {data.widgets.length === 0 ? (
            <div className="card dash-empty" data-testid="widgets-empty">
              <ChartColumnStacked className="panel__icon" aria-hidden="true" />
              {data.canEdit ? (
                <>
                  <h4>{td.widgets.emptyTitle}</h4>
                  <p className="muted">{td.widgets.emptyBody}</p>
                  <button type="button" className="button button--primary" onClick={() => setDialog({ widget: null })} data-testid="widget-add">
                    <Plus className="icon" aria-hidden="true" />
                    {td.widgets.add}
                  </button>
                </>
              ) : (
                <p className="muted">{td.widgets.emptyViewer}</p>
              )}
            </div>
          ) : (
            <div className="dash-grid dash-grid--widgets">
              {data.widgets.map((w, i) => {
                const result = data.results.find((r) => r.widgetId === w.id) ?? data.results[i]
                const sheet = data.sheets.find((s) => s.sheetId === w.sheetId)
                return (
                  <article key={w.id} className={`card widget widget--${w.display}`} aria-labelledby={`widget-${w.id}`} data-testid="widget" data-widget-id={w.id}>
                    <header className="widget__head">
                      <div className="widget__heading">
                        <h4 id={`widget-${w.id}`} className="widget__title">
                          <bdi>{w.title}</bdi>
                        </h4>
                        <p className="muted small widget__source">
                          {t.dashboard.aggregation[w.aggregation]} ·{' '}
                          <bdi dir="ltr">{w.source.kind === 'column' ? w.source.column : w.source.range}</bdi>
                          {sheet ? (
                            <>
                              {' · '}
                              <bdi>{sheet.title}</bdi>
                            </>
                          ) : null}
                        </p>
                      </div>
                      {data.canEdit ? (
                        <div className="widget__actions">
                          <button type="button" className="icon-button" aria-label={`${td.widgets.moveEarlier}: ${w.title}`} title={td.widgets.moveEarlier} disabled={i === 0} onClick={() => void move(i, -1)} data-testid="widget-earlier">
                            <ArrowUp className="icon" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={`${td.widgets.moveLater}: ${w.title}`}
                            title={td.widgets.moveLater}
                            disabled={i === data.widgets.length - 1}
                            onClick={() => void move(i, 1)}
                            data-testid="widget-later"
                          >
                            <ArrowDown className="icon" aria-hidden="true" />
                          </button>
                          <button type="button" className="icon-button" aria-label={`${td.widgets.edit}: ${w.title}`} title={td.widgets.edit} onClick={() => setDialog({ widget: w })} data-testid="widget-edit">
                            <Pencil className="icon" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="icon-button icon-button--danger"
                            aria-label={`${td.widgets.remove}: ${w.title}`}
                            title={td.widgets.remove}
                            onClick={() => setRemoval({ widget: w, busy: false, error: null })}
                            data-testid="widget-remove"
                          >
                            <Trash2 className="icon" aria-hidden="true" />
                          </button>
                        </div>
                      ) : null}
                    </header>
                    {result ? <WidgetFigure workbookId={workbookId} title={w.title} result={result} display={w.display} aggregation={w.aggregation} /> : null}
                  </article>
                )
              })}
            </div>
          )}
        </section>
      </div>

      {dialog ? (
        <WidgetDialog
          key={dialog.widget?.id ?? 'new'}
          workbookId={workbookId}
          sheets={data.sheets}
          widget={dialog.widget}
          onClose={() => setDialog(null)}
          onSaved={(_widget, created) => {
            setDialog(null)
            setAnnounce(created ? td.widgets.added : td.widgets.saved)
            void refresh()
          }}
        />
      ) : null}
      {removal ? (
        <RemoveWidgetDialog
          widget={removal.widget}
          busy={removal.busy}
          error={removal.error}
          onDecide={(confirmed) => {
            if (confirmed) void removeConfirmed(removal.widget)
            else setRemoval(null)
          }}
        />
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

type Href = (link: CellLink) => string
type Go = (link: CellLink | null) => () => void

function Kpi({
  Icon,
  tone,
  label,
  value,
  detail,
  link,
  href,
  testId,
  progress,
}: {
  Icon: LucideIcon
  tone: 'success' | 'danger' | 'info' | 'neutral'
  label: string
  value: string
  detail: string
  link: CellLink | null
  href: Href
  testId: string
  progress?: number | null
}) {
  const body = (
    <>
      <span className="kpi__label">
        <span className={`kpi__icon kpi__icon--${tone}`} aria-hidden="true">
          <Icon className="icon" />
        </span>
        {label}
      </span>
      <bdi dir="ltr" className="kpi__value num">
        {value}
      </bdi>
      {progress !== undefined ? (
        <span className="kpi__bar" aria-hidden="true">
          <span className="kpi__bar-fill" style={{ inlineSize: `${Math.round(Math.min(1, Math.max(0, progress ?? 0)) * 100)}%` }} />
        </span>
      ) : null}
      <span className="kpi__detail muted">{detail}</span>
    </>
  )
  return link ? (
    <Link className="kpi kpi--link" href={href(link)} aria-label={`${label}: ${value}. ${t.dashboard.openCells}`} data-testid={testId}>
      {body}
    </Link>
  ) : (
    <div className="kpi" data-testid={testId}>
      {body}
    </div>
  )
}

function DashCard({ title, Icon, children, testId, wide, aside }: { title: string; Icon: LucideIcon; children: ReactNode; testId: string; wide?: boolean; aside?: ReactNode }) {
  const id = `${testId}-title`
  return (
    <section className={wide ? 'card dash-card dash-card--wide' : 'card dash-card'} aria-labelledby={id} data-testid={testId}>
      <header className="dash-card__head">
        <h3 id={id} className="with-icon">
          <Icon className="icon dash-card__icon" aria-hidden="true" />
          {title}
        </h3>
        {aside}
      </header>
      {children}
    </section>
  )
}

function useStatusSeries(): SeriesSpec[] {
  const tokens = useChartTokens()
  return [
    { key: 'done', label: td.status.done, colour: tokens['--chart-done'] },
    { key: 'open', label: td.status.open, colour: tokens['--chart-open'] },
    { key: 'overdue', label: td.status.overdue, colour: tokens['--chart-overdue'] },
  ]
}

/** The three states, each with its icon, label and colour (never colour alone). */
function StatusLegend() {
  const series = useStatusSeries()
  return (
    <ul className="legend legend--inline" aria-hidden="true">
      {series.map((s) => {
        const Icon = STATUS_ICON[s.key as DashboardTaskStatus]
        return (
          <li key={s.key} className="legend__item">
            <span className="swatch swatch--sm" style={{ background: s.colour }} />
            <Icon className="icon legend__icon" />
            {s.label}
          </li>
        )
      })}
    </ul>
  )
}

function Counts({ done, open, overdue }: { done: number; open: number; overdue: number }) {
  return (
    <span className="status-counts">
      {(['done', 'open', 'overdue'] as const).map((k) => {
        const Icon = STATUS_ICON[k]
        const n = { done, open, overdue }[k]
        return (
          <span key={k} className={`status-count status-count--${k}`} title={td.status[k]}>
            <Icon className="icon" aria-hidden="true" />
            <span className="sr-only">{td.status[k]}</span>
            <bdi dir="ltr" className="num">
              {formatNumber(n)}
            </bdi>
          </span>
        )
      })}
    </span>
  )
}

function SheetsCard({ data, href, go }: { data: DashboardResponse; href: Href; go: Go }) {
  const series = useStatusSeries()
  const sheets = data.sheets.filter((s) => s.kind === 'tasks')
  const rows: BarRow[] = sheets.map((s) => ({ label: s.title, done: s.done, open: s.open, overdue: s.overdue }))
  return (
    <DashCard title={td.sheets.title} Icon={Sheet} testId="dash-sheets" aside={<StatusLegend />}>
      <HorizontalBars rows={rows} series={series} label={td.sheets.title} onSelect={(i) => go(sheets[i]?.link ?? null)()} />
      <ul className="dash-list">
        {data.sheets.map((s) => (
          <li key={s.sheetId}>
            <Link className="dash-list__item" href={href(s.link)} aria-label={`${s.title}: ${t.dashboard.openCells}`} data-testid="dash-sheet-link">
              <span className="dash-list__main">
                <bdi className="dash-list__title">{s.title}</bdi>
                {s.kind === 'plain' ? <span className="muted small">{td.sheets.plain}</span> : null}
                {s.issues > 0 ? (
                  <span className="badge badge--warning">
                    <TriangleExclamationPoint className="icon" aria-hidden="true" />
                    {td.sheets.issues(formatNumber(s.issues))}
                  </span>
                ) : null}
              </span>
              {s.kind === 'tasks' ? (
                <span className="dash-list__end">
                  <Counts done={s.done} open={s.open} overdue={s.overdue} />
                  <bdi dir="ltr" className="num dash-list__share">
                    {formatShare(s.completion)}
                  </bdi>
                </span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </DashCard>
  )
}

function PeopleCard({ data, href, go }: { data: DashboardResponse; href: Href; go: Go }) {
  const series = useStatusSeries()
  const shown = data.assignees.slice(0, PEOPLE_IN_CHART)
  const rows: BarRow[] = shown.map((a) => ({ label: a.name, done: a.done, open: a.open, overdue: a.overdue }))
  return (
    <DashCard title={td.people.title} Icon={Users} testId="dash-people" aside={data.assignees.length > 0 ? <StatusLegend /> : null}>
      {data.assignees.length === 0 ? (
        <p className="dash-empty-line muted">{td.people.empty}</p>
      ) : (
        <>
          <HorizontalBars rows={rows} series={series} label={td.people.title} onSelect={(i) => go(shown[i]?.link ?? null)()} />
          <ul className="dash-list dash-list--scroll">
            {data.assignees.map((a) => {
              const content = (
                <>
                  <span className="dash-list__main">
                    {a.kind === 'external' ? <Building2 className="icon muted" aria-label={td.people.external} /> : null}
                    {a.kind === 'unmatched' ? <UserRoundX className="icon muted" aria-label={td.people.unmatched} /> : null}
                    <bdi className="dash-list__title">{a.name}</bdi>
                    {a.kind === 'external' ? <span className="muted small">{td.people.external}</span> : null}
                    {a.kind === 'unmatched' ? <span className="muted small">{td.people.unmatched}</span> : null}
                  </span>
                  <span className="dash-list__end">
                    <Counts done={a.done} open={a.open} overdue={a.overdue} />
                  </span>
                </>
              )
              return (
                <li key={a.key}>
                  {a.link ? (
                    <Link className="dash-list__item" href={href(a.link)} aria-label={`${a.name}: ${t.dashboard.openCells}`} data-testid="dash-person-link">
                      {content}
                    </Link>
                  ) : (
                    <span className="dash-list__item">{content}</span>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}
    </DashCard>
  )
}

function TimelineCard({ data, href, go }: { data: DashboardResponse; href: Href; go: Go }) {
  const series = useStatusSeries()
  const rows: BarRow[] = data.timeline.map((w) => ({ label: w.weekStart, done: w.done, open: w.open, overdue: w.overdue }))
  return (
    <DashCard title={td.timeline.title} Icon={CalendarClock} testId="dash-timeline" wide aside={data.timeline.length > 0 ? <StatusLegend /> : null}>
      {data.timeline.length === 0 ? (
        <p className="dash-empty-line muted">{td.timeline.empty}</p>
      ) : (
        <>
          <Columns rows={rows} series={series} label={td.timeline.title} highlight={data.weekStart} onSelect={(i) => go(data.timeline[i]?.link ?? null)()} />
          {data.timelineTruncated ? <p className="muted small">{td.timeline.truncated(formatNumber(data.timeline.length))}</p> : null}
          <details className="chart-data">
            <summary>{t.dashboard.showTable}</summary>
            <div className="table-wrap">
              <table className="data-table data-table--compact">
                <thead>
                  <tr>
                    <th scope="col">{td.timeline.weekOf}</th>
                    <th scope="col">{td.status.done}</th>
                    <th scope="col">{td.status.open}</th>
                    <th scope="col">{td.status.overdue}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.timeline.map((w) => (
                    <tr key={w.weekStart}>
                      <th scope="row">
                        {w.link ? (
                          <Link href={href(w.link)}>
                            <bdi dir="ltr" className="num">
                              {w.weekStart}
                            </bdi>
                          </Link>
                        ) : (
                          <bdi dir="ltr" className="num">
                            {w.weekStart}
                          </bdi>
                        )}
                        {w.weekStart === data.weekStart ? <span className="muted small"> {td.timeline.thisWeek}</span> : null}
                      </th>
                      <td>
                        <bdi dir="ltr" className="num">
                          {formatNumber(w.done)}
                        </bdi>
                      </td>
                      <td>
                        <bdi dir="ltr" className="num">
                          {formatNumber(w.open)}
                        </bdi>
                      </td>
                      <td>
                        <bdi dir="ltr" className="num">
                          {formatNumber(w.overdue)}
                        </bdi>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </DashCard>
  )
}

function SubtasksCard({ data, href }: { data: DashboardResponse; href: Href }) {
  return (
    <DashCard title={td.subtasks.title} Icon={ListChecks} testId="dash-subtasks">
      {data.subtasks.parents.length === 0 ? (
        <p className="dash-empty-line muted">{td.subtasks.empty}</p>
      ) : (
        <ul className="dash-list dash-list--scroll">
          {data.subtasks.parents.map((p) => (
            <li key={p.uid}>
              <Link className="dash-list__item dash-list__item--stacked" href={href(p.link)} aria-label={`${p.title}: ${td.subtasks.of(formatNumber(p.done), formatNumber(p.total))}`}>
                <span className="dash-list__main">
                  <bdi className="dash-list__title">{p.title}</bdi>
                  <bdi dir="ltr" className="num muted small">
                    {formatNumber(p.done)}/{formatNumber(p.total)}
                  </bdi>
                </span>
                <span className="meter" aria-hidden="true">
                  <span className="meter__fill" style={{ inlineSize: `${Math.round((p.total > 0 ? p.done / p.total : 0) * 100)}%` }} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </DashCard>
  )
}

function TaskListCard({
  title,
  Icon,
  tasks,
  total,
  limit,
  empty,
  href,
  testId,
}: {
  title: string
  Icon: LucideIcon
  tasks: DashboardTask[]
  total: number
  limit: number
  empty: string
  href: Href
  testId: string
}) {
  return (
    <DashCard
      title={title}
      Icon={Icon}
      testId={testId}
      aside={
        <bdi dir="ltr" className="num dash-card__count">
          {formatNumber(total)}
        </bdi>
      }
    >
      {tasks.length === 0 ? (
        <p className="dash-empty-line muted">{empty}</p>
      ) : (
        <>
          <ul className="dash-list dash-list--scroll">
            {tasks.map((task) => (
              <li key={task.uid}>
                <Link className="dash-list__item dash-list__item--stacked" href={href(task.link)} data-testid="dash-task-link">
                  <span className="dash-list__main">
                    <bdi className="dash-list__title">{task.title}</bdi>
                    {task.level === 1 ? <span className="badge badge--neutral">{td.taskMeta.subtask}</span> : null}
                  </span>
                  <span className="dash-list__meta muted small">
                    <span>
                      {td.taskMeta.due}{' '}
                      <bdi dir="ltr" className="num">
                        {task.dueOn ?? ''}
                      </bdi>
                    </span>
                    <span>
                      <bdi>{task.sheetTitle}</bdi>
                    </span>
                    <span>{task.assignees.length > 0 ? <bdi>{task.assignees.join('، ')}</bdi> : td.taskMeta.unassigned}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {total > tasks.length ? <p className="muted small">{td.overdue.more(formatNumber(Math.min(limit, tasks.length)), formatNumber(total))}</p> : null}
        </>
      )}
    </DashCard>
  )
}

function ActivityCard({ data, href }: { data: DashboardResponse; href: Href }) {
  return (
    <DashCard title={td.activity.title} Icon={Activity} testId="dash-activity" wide>
      {data.activity.length === 0 ? (
        <p className="dash-empty-line muted">{td.activity.empty}</p>
      ) : (
        <ol className="activity-list">
          {data.activity.map((a) => {
            const Dir = a.direction === 'out' ? CloudUpload : CloudDownload
            const failed = a.status === 'error'
            const label = (
              <>
                <span className="activity__what">{activityLabel(a.action)}</span>
                {a.taskTitle ? (
                  <>
                    {' — '}
                    <bdi>{a.taskTitle}</bdi>
                  </>
                ) : null}
              </>
            )
            return (
              <li key={a.id} className="activity">
                <span className={`activity__dir activity__dir--${a.direction}`} title={a.direction === 'out' ? td.activity.out : td.activity.in}>
                  <Dir className="icon" aria-hidden="true" />
                  <span className="sr-only">{a.direction === 'out' ? td.activity.out : td.activity.in}</span>
                </span>
                <span className="activity__body">
                  {a.link ? <Link href={href(a.link)}>{label}</Link> : <span>{label}</span>}
                  <span className="muted small activity__meta">
                    <bdi>{a.actorName ?? td.activity.system}</bdi>
                    {' · '}
                    <bdi dir="ltr" className="num">
                      {formatDateTime(a.at) ?? ''}
                    </bdi>
                    {failed ? (
                      <span className="badge badge--danger">
                        <TriangleExclamationPoint className="icon" aria-hidden="true" />
                        {td.activity.failed}
                      </span>
                    ) : null}
                    {a.status === 'conflict' ? (
                      <span className="badge badge--warning">
                        <TriangleExclamationPoint className="icon" aria-hidden="true" />
                        {td.activity.conflict}
                      </span>
                    ) : null}
                  </span>
                </span>
              </li>
            )
          })}
        </ol>
      )}
    </DashCard>
  )
}
