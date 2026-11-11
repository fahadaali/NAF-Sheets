// Import report (spec §7.2 «تقرير الاستيراد», §12.1 item 7): how much was
// transferred, and every item that was not transferred, was kept as a static
// value or changed form, grouped by sheet, each with its location and a link
// that opens the editor on that place.
// GET /api/workbooks/:id/import-report.
// OPEN: the report is read by workbook id; `reportId` from the import answer
// is not used, and an item on a hidden or missing sheet opens the editor with
// a notice instead of a selection (OPEN_QUESTIONS.md #31).

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { CircleCheck, CircleX, LoaderCircle, LocateFixed, Repeat, Sheet, Workflow } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { CurrentUser, ImportReportResponse } from '@naf-sheets/shared'
import type { ImportReport, ImportReportItem } from '@naf-sheets/gsheets-import'
import { AppBar } from '../components/AppBar'
import { Notice } from '../components/Notice'
import { api, errorMessage, isAbortError } from '../lib/api'
import { formatCount, formatDateTime } from '../lib/format'
import { COUNT_KEYS, OPTIONAL_COUNT_KEYS, groupReportItems, itemTarget, originFacts, outcomeCounts, parseImportReport } from '../lib/import-report'
import type { OriginFacts, ReportGroup } from '../lib/import-report'
import { Link } from '../lib/router'
import { pathFor } from '../lib/routes'
import { useDocumentTitle } from '../lib/use-document-title'
import { t } from '../strings'

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'invalid' }
  | { kind: 'ready'; response: ImportReportResponse; report: ImportReport }

const OUTCOME_LOOK: Record<ImportReportItem['outcome'], { Icon: LucideIcon; tone: string }> = {
  not_transferred: { Icon: CircleX, tone: 'danger' },
  value_only: { Icon: Workflow, tone: 'warning' },
  converted: { Icon: Repeat, tone: 'info' },
}

export function ImportReportScreen({ id, user }: { id: string; user: CurrentUser | null }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useDocumentTitle(t.report.title)

  useEffect(() => {
    const controller = new AbortController()
    setLoad({ kind: 'loading' })
    api.getImportReport(id, controller.signal).then(
      (response) => {
        const report = parseImportReport(response.report)
        setLoad(report ? { kind: 'ready', response, report } : { kind: 'invalid' })
      },
      (error: unknown) => {
        if (!isAbortError(error)) setLoad({ kind: 'error', message: errorMessage(error) })
      },
    )
    return () => controller.abort()
  }, [id, attempt])

  const openFile = (
    <Link className="button button--primary" href={pathFor({ name: 'editor', id })} data-testid="report-open-file">
      {t.report.openFile}
    </Link>
  )

  return (
    <>
      <a className="skip-link" href="#main">
        {t.skipToContent}
      </a>
      <AppBar user={user} />
      <main id="main" className="page" data-screen="import-report">
        <div className="page-head">
          <h1>{t.report.title}</h1>
        </div>
        {load.kind === 'loading' ? (
          <div className="panel panel--plain" role="status">
            <LoaderCircle className="panel__icon spin" aria-hidden="true" />
            <p>{t.report.loading}</p>
          </div>
        ) : null}
        {load.kind === 'error' ? (
          <Notice
            tone="danger"
            testId="report-error"
            actions={
              <button type="button" className="button button--small" onClick={() => setAttempt((n) => n + 1)}>
                {t.files.retry}
              </button>
            }
          >
            <p>{load.message}</p>
          </Notice>
        ) : null}
        {load.kind === 'invalid' ? (
          <Notice tone="danger" testId="report-invalid" actions={openFile}>
            <p>{t.report.invalid}</p>
          </Notice>
        ) : null}
        {load.kind === 'ready' ? <Report id={id} response={load.response} report={load.report} actions={openFile} /> : null}
      </main>
    </>
  )
}

function Report({ id, response, report, actions }: { id: string; response: ImportReportResponse; report: ImportReport; actions: ReactNode }) {
  const groups = groupReportItems(report)
  const outcomes = outcomeCounts(report.items)
  const importedAt = formatDateTime(response.createdAt)
  const origin = originFacts(report)
  return (
    <div className="stack">
      <section className="card" data-testid="report-summary">
        <div className="card__head">
          <h2>
            <bdi>{report.source.title}</bdi>
          </h2>
        </div>
        <p className="muted" data-testid="report-source">
          {t.report.originKinds[origin.kind] ?? t.report.source}
          {importedAt ? (
            <>
              {' · '}
              {t.report.importedAt}{' '}
              <bdi dir="ltr" className="num">
                {importedAt}
              </bdi>
            </>
          ) : null}
        </p>
        <OriginList origin={origin} />
        <h3 className="card__subhead">{t.report.countsTitle}</h3>
        <dl className="counts" data-testid="report-counts">
          {COUNT_KEYS.map((key) => (
            <div key={key} className="counts__item" data-count={key}>
              <dt>{t.report.counts[key]}</dt>
              <dd>
                <bdi className="num">{formatCount(report.counts[key])}</bdi>
              </dd>
            </div>
          ))}
          {OPTIONAL_COUNT_KEYS.map((key) => {
            const value = (report.counts as Partial<Record<(typeof OPTIONAL_COUNT_KEYS)[number], number>>)[key]
            return typeof value === 'number' ? (
              <div key={key} className="counts__item" data-count={key}>
                <dt>{t.report.counts[key]}</dt>
                <dd>
                  <bdi className="num">{formatCount(value)}</bdi>
                </dd>
              </div>
            ) : null
          })}
        </dl>
        <div className="card__actions">
          {actions}
          <Link className="button" href={pathFor({ name: 'linkWizard', id })}>
            {t.report.linkProject}
          </Link>
        </div>
      </section>

      {groups.length === 0 ? (
        <section className="panel" data-testid="report-no-items">
          <CircleCheck className="panel__icon" aria-hidden="true" />
          <h2>{t.report.noItemsTitle}</h2>
          <p>{t.report.noItemsBody}</p>
        </section>
      ) : (
        <section aria-labelledby="report-items-heading" className="stack">
          <div className="section-head">
            <h2 id="report-items-heading">{t.report.itemsTitle}</h2>
            <p className="muted" data-testid="report-outcomes">
              {t.report.itemsSummary(outcomes.not_transferred, outcomes.value_only, outcomes.converted)}
            </p>
          </div>
          {groups.map((group) => (
            <ReportGroupCard key={group.sheetId ?? '__workbook'} id={id} group={group} />
          ))}
        </section>
      )}
    </div>
  )
}

function OriginList({ origin }: { origin: OriginFacts }) {
  return (
    <>
      <h3 className="card__subhead">{t.report.originTitle}</h3>
      <dl className="report-origin" data-testid="report-origin" data-origin={origin.kind} data-via={origin.via}>
        <div>
          <dt>{t.report.originLabel}</dt>
          <dd>{t.report.originKinds[origin.kind] ?? t.report.otherKind}</dd>
        </div>
        <div>
          <dt>{t.report.viaLabel}</dt>
          <dd>{t.report.via[origin.via] ?? t.report.otherKind}</dd>
        </div>
        {origin.fileName ? (
          <div>
            <dt>{t.report.fileNameLabel}</dt>
            <dd>
              <bdi dir="ltr">{origin.fileName}</bdi>
            </dd>
          </div>
        ) : null}
        {origin.application ? (
          <div>
            <dt>{t.report.applicationLabel}</dt>
            <dd>
              <bdi dir="ltr">{origin.application}</bdi>
            </dd>
          </div>
        ) : null}
        {origin.defaultFont ? (
          <div>
            <dt>{t.report.defaultFontLabel}</dt>
            <dd>
              <bdi dir="ltr" className="num">
                {origin.defaultFont}
              </bdi>{' '}
              <span className="muted">{t.report.defaultFontNote}</span>
            </dd>
          </div>
        ) : null}
        {origin.dateSystem ? (
          <div>
            <dt>{t.report.dateSystemLabel}</dt>
            <dd>{t.report.dateSystem[origin.dateSystem]}</dd>
          </div>
        ) : null}
        <div>
          <dt>{t.report.alignmentLabel}</dt>
          <dd>{t.report.alignmentValue}</dd>
        </div>
      </dl>
    </>
  )
}

function ReportGroupCard({ id, group }: { id: string; group: ReportGroup }) {
  const headingId = `report-group-${group.sheetId ?? 'workbook'}`
  return (
    <section className="card" aria-labelledby={headingId} data-report-sheet={group.sheetId ?? ''}>
      <div className="card__head">
        <h3 id={headingId} className="with-icon">
          <Sheet className="icon" aria-hidden="true" />
          {group.sheetName === null ? t.report.wholeWorkbook : <bdi>{group.sheetName}</bdi>}
        </h3>
        {group.hidden ? <span className="badge badge--neutral">{t.report.hiddenSheet}</span> : null}
        <span className="muted num">
          <bdi>{formatCount(group.items.length)}</bdi>
        </span>
      </div>
      <ul className="report-items">
        {group.items.map((item, index) => (
          <ReportItemRow key={index} id={id} item={item} />
        ))}
      </ul>
    </section>
  )
}

function ReportItemRow({ id, item }: { id: string; item: ImportReportItem }) {
  const look = OUTCOME_LOOK[item.outcome]
  const { Icon } = look
  const target = itemTarget(item)
  const loc = item.location
  return (
    <li className="report-item" data-kind={item.kind} data-outcome={item.outcome}>
      <div className="report-item__head">
        <span className={`badge badge--${look.tone}`}>
          <Icon className="icon" aria-hidden="true" />
          {t.report.outcome[item.outcome]}
        </span>
        <strong>{t.report.kinds[item.kind] ?? t.report.otherKind}</strong>
      </div>
      <p>{item.message}</p>
      {item.detail ? (
        <p className="report-item__detail">
          <span className="muted">{t.report.original}: </span>
          <bdi dir="ltr">
            <code>{item.detail}</code>
          </bdi>
        </p>
      ) : null}
      {loc && target ? (
        <p className="report-item__where">
          <span className="muted">{t.report.location}: </span>
          {/* `'ورقة'!B4:C10` is read left to right, like a formula reference (spec §7.2 «ورقة!خلية»). */}
          <bdi dir="ltr" className="num">
            {loc.ref}
          </bdi>
          {loc.range ? null : <span className="muted">({t.report.wholeSheet})</span>}
          <Link className="button button--small" href={pathFor({ name: 'editor', id, target })} data-testid="report-go-to">
            <LocateFixed className="icon" aria-hidden="true" />
            {t.report.goTo}
          </Link>
        </p>
      ) : null}
    </li>
  )
}
