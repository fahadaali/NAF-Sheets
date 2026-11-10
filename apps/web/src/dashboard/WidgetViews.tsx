// A custom widget's figure: a number, bars, a pie or donut, a line, or a
// summary table — with the same groups as links to their cells (keyboard
// and screen readers), and the notes on what was not counted.

import { TriangleExclamationPoint } from 'lucide-react'
import type { DashboardAggregation, DashboardDisplay, WidgetResult } from '@naf-sheets/shared'
import { Link, navigate } from '../lib/router'
import { t } from '../strings'
import { HorizontalBars, LineSeries, PieRing, seriesColour, useChartTokens } from './charts'
import type { BarRow, PieDatum } from './charts'
import { cellsHref, formatNumber, formatShare, groupLabel, pieSlices } from './model'

const tw = t.dashboard.widgets

/** Groups drawn in a bar or line chart; the table and the list carry all of them. */
const CHART_GROUP_LIMIT = 12

export function WidgetFigure({
  workbookId,
  title,
  result,
  display,
  aggregation,
}: {
  workbookId: string
  title: string
  result: WidgetResult
  display: DashboardDisplay
  aggregation: DashboardAggregation
}) {
  const tokens = useChartTokens()
  if (!result.ok) {
    return (
      <p className="widget__problem" role="status">
        <TriangleExclamationPoint className="icon" aria-hidden="true" />
        {result.message}
      </p>
    )
  }
  const aggregationName = t.dashboard.aggregation[aggregation] ?? ''
  const go = (link: { sheetId: string; range: string } | null) => (link ? () => navigate(cellsHref(workbookId, link)) : undefined)
  const groups = result.groups ?? []
  const notes = (
    <ul className="widget__notes">
      {result.skipped > 0 ? <li>{tw.skipped(formatNumber(result.skipped))}</li> : null}
      {result.uncomputed > 0 ? <li>{tw.uncomputed(formatNumber(result.uncomputed))}</li> : null}
      {result.otherGroups > 0 ? <li>{tw.otherGroups(formatNumber(result.otherGroups))}</li> : null}
    </ul>
  )

  const total = (
    <p className="widget__total">
      <span className="muted">
        {aggregationName}
        {groups.length > 0 ? ` · ${tw.total}` : ''}
      </span>
      {result.link ? (
        <Link className="widget__total-value" href={cellsHref(workbookId, result.link)} aria-label={t.dashboard.openCellsOf(title)} data-testid="widget-total">
          <bdi dir="ltr" className="num">
            {formatNumber(result.value)}
          </bdi>
        </Link>
      ) : (
        <bdi dir="ltr" className="num widget__total-value" data-testid="widget-total">
          {formatNumber(result.value)}
        </bdi>
      )}
    </p>
  )

  if (display === 'kpi' || groups.length === 0) {
    return (
      <div className="widget__body widget__body--kpi">
        {result.link ? (
          <Link className="widget__kpi" href={cellsHref(workbookId, result.link)} aria-label={t.dashboard.openCellsOf(title)} data-testid="widget-kpi">
            <bdi dir="ltr" className="num">
              {formatNumber(result.value)}
            </bdi>
          </Link>
        ) : (
          <span className="widget__kpi" data-testid="widget-kpi">
            <bdi dir="ltr" className="num">
              {formatNumber(result.value)}
            </bdi>
          </span>
        )}
        <p className="muted">{aggregationName}</p>
        {notes}
      </div>
    )
  }

  const table = (
    <div className="table-wrap">
      <table className="data-table data-table--compact" data-testid="widget-table">
        <thead>
          <tr>
            <th scope="col">{tw.group}</th>
            <th scope="col">{aggregationName}</th>
            <th scope="col">{tw.cells}</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g, i) => (
            <tr key={i}>
              <th scope="row">
                {g.link ? (
                  <Link href={cellsHref(workbookId, g.link)} aria-label={t.dashboard.openCellsOf(groupLabel(g.label))}>
                    <bdi>{groupLabel(g.label)}</bdi>
                  </Link>
                ) : (
                  <bdi>{groupLabel(g.label)}</bdi>
                )}
              </th>
              <td>
                <bdi dir="ltr" className="num">
                  {formatNumber(g.value)}
                </bdi>
              </td>
              <td>
                <bdi dir="ltr" className="num">
                  {formatNumber(g.cells)}
                </bdi>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )

  if (display === 'table') {
    return (
      <div className="widget__body">
        {table}
        {total}
        {notes}
      </div>
    )
  }

  if (display === 'pie' || display === 'donut') {
    const { slices } = pieSlices(groups, aggregation)
    const data: PieDatum[] = slices.map((s, i) => ({ label: s.label, value: s.value, colour: seriesColour(tokens, i) }))
    const sum = slices.reduce((n, s) => n + s.value, 0)
    return (
      <div className="widget__body widget__body--pie">
        <PieRing
          data={data}
          donut={display === 'donut'}
          label={title}
          onSelect={(i) => go(slices[i]?.link ?? null)?.()}
          centre={
            <>
              <bdi dir="ltr" className="num">
                {formatNumber(result.value)}
              </bdi>
              <span className="muted small">{aggregationName}</span>
            </>
          }
        />
        <ul className="legend" data-testid="widget-legend">
          {slices.map((s, i) => {
            const body = (
              <>
                <span className="swatch swatch--sm" style={{ background: seriesColour(tokens, i) }} aria-hidden="true" />
                <bdi className="legend__label">{s.label}</bdi>
                <bdi dir="ltr" className="num legend__value">
                  {formatNumber(s.value)}
                </bdi>
                <bdi dir="ltr" className="num muted legend__share">
                  {formatShare(sum > 0 ? s.value / sum : null)}
                </bdi>
              </>
            )
            return (
              <li key={i}>
                {s.link ? (
                  <Link className="legend__item" href={cellsHref(workbookId, s.link)} aria-label={t.dashboard.openCellsOf(s.label)}>
                    {body}
                  </Link>
                ) : (
                  <span className="legend__item">{body}</span>
                )}
              </li>
            )
          })}
        </ul>
        {notes}
      </div>
    )
  }

  const shown = groups.slice(0, CHART_GROUP_LIMIT)
  const rows: BarRow[] = shown.map((g) => ({ label: groupLabel(g.label), value: g.value }))
  const select = (i: number) => go(shown[i]?.link ?? null)?.()
  return (
    <div className="widget__body">
      {display === 'line' ? (
        <LineSeries rows={rows} colour={seriesColour(tokens, 0)} name={aggregationName} label={title} onSelect={select} />
      ) : (
        <HorizontalBars rows={rows} series={[{ key: 'value', label: aggregationName, colour: seriesColour(tokens, 0) }]} stacked={false} label={title} onSelect={select} />
      )}
      {total}
      <details className="chart-data">
        <summary>{t.dashboard.showTable}</summary>
        {table}
      </details>
      {notes}
    </div>
  )
}
