// Charts of the dashboard, on Recharts (pinned 3.10.1), drawn right to left:
//
// - category bars are horizontal, their labels on the right (the start of an
//   Arabic line) and the bars growing leftwards (the value axis reversed);
// - time and sequence axes run from right to left (oldest on the right), with
//   the value axis on the right;
// - pies start at twelve o'clock and run counter-clockwise (the mirror of the
//   usual clockwise reading);
// - every text in the SVG is drawn in the Thmanyah font (CSS) with an explicit
//   direction, so Arabic labels shape and order correctly;
// - legends and tooltips are HTML, written right to left.
//
// Colours come from theme.css through `useThemeTokens` (Recharts needs
// literal values). Every chart is paired, in its card, with a list of the same
// figures as links (keyboard and screen readers); the marks are clickable too.

import type { ReactNode } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useThemeTokens } from '../lib/theme-colors'
import { formatNumber } from './model'

export const SERIES_TOKENS = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6', '--chart-7', '--chart-8'] as const
const CHART_TOKENS = [...SERIES_TOKENS, '--chart-done', '--chart-open', '--chart-overdue', '--chart-grid', '--chart-axis', '--chart-cursor', '--color-surface', '--chart-bar-size', '--chart-radius'] as const

export type ChartTokens = Record<(typeof CHART_TOKENS)[number], string>

export function useChartTokens(): ChartTokens {
  return useThemeTokens(CHART_TOKENS)
}

/** Series colour `i` (0-based), cycling through the eight. */
export function seriesColour(tokens: ChartTokens, i: number): string {
  return tokens[SERIES_TOKENS[i % SERIES_TOKENS.length] as (typeof SERIES_TOKENS)[number]]
}

const num = (text: string, fallback: number) => {
  const n = Number.parseFloat(text)
  return Number.isFinite(n) ? n : fallback
}

const shorten = (text: string, max = 18) => ([...text].length > max ? `${[...text].slice(0, max - 1).join('')}…` : text)

interface TickProps {
  x?: number | string
  y?: number | string
  payload?: { value?: unknown }
}

/** A category label on the right-hand axis: right to left, its end against the axis. */
function StartTick({ x = 0, y = 0, payload }: TickProps) {
  const label = String(payload?.value ?? '')
  return (
    <text x={Number(x)} y={Number(y)} dy={4} textAnchor="end" direction="rtl" className="chart__tick chart__tick--label">
      <title>{label}</title>
      {shorten(label)}
    </text>
  )
}

/** A number or date label: left to right. */
function LatinTick({ x = 0, y = 0, payload, anchor = 'middle', dy = 12 }: TickProps & { anchor?: 'start' | 'middle' | 'end'; dy?: number }) {
  const value = payload?.value
  return (
    <text x={Number(x)} y={Number(y)} dy={dy} textAnchor={anchor} direction="ltr" className="chart__tick">
      {typeof value === 'number' ? formatNumber(value) : String(value ?? '')}
    </text>
  )
}

export interface SeriesSpec {
  key: string
  label: string
  colour: string
}

interface TooltipEntry {
  name?: unknown
  value?: unknown
  color?: string
  payload?: Record<string, unknown>
}

function ChartTooltip({ active, payload, label, title }: { active?: boolean; payload?: readonly TooltipEntry[]; label?: unknown; title?: (label: unknown, payload: readonly TooltipEntry[]) => ReactNode }) {
  if (!active || !payload || payload.length === 0) return null
  return (
    <div className="chart-tooltip" dir="rtl">
      <p className="chart-tooltip__title">{title ? title(label, payload) : <bdi>{String(label ?? payload[0]?.payload?.label ?? '')}</bdi>}</p>
      <ul>
        {payload.map((entry, i) => (
          <li key={i}>
            <span className="swatch swatch--sm" style={{ background: entry.color }} aria-hidden="true" />
            {String(entry.name ?? '')}
            <bdi dir="ltr" className="num">
              {typeof entry.value === 'number' ? formatNumber(entry.value) : String(entry.value ?? '')}
            </bdi>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Rows of a horizontal bar chart: one category each. */
export interface BarRow {
  label: string
  [series: string]: string | number | null
}

/**
 * Horizontal bars, one row per category, stacked when there are several
 * series. `onSelect` gets the row index.
 */
export function HorizontalBars({ rows, series, onSelect, label, stacked = true }: { rows: readonly BarRow[]; series: readonly SeriesSpec[]; onSelect?: (index: number) => void; label: string; stacked?: boolean }) {
  const tokens = useChartTokens()
  const barSize = num(tokens['--chart-bar-size'], 14)
  const radius = num(tokens['--chart-radius'], 4)
  const height = Math.max(120, rows.length * (barSize + 22) + 36)
  return (
    <div className="chart" style={{ blockSize: height }} role="img" aria-label={label} data-chart="bars">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows as BarRow[]} layout="vertical" margin={{ top: 4, right: 8, bottom: 4, left: 8 }} barCategoryGap={8}>
          <CartesianGrid horizontal={false} stroke={tokens['--chart-grid']} strokeDasharray="3 3" />
          <XAxis type="number" reversed allowDecimals={false} tick={<LatinTick />} stroke={tokens['--chart-axis']} tickLine={false} axisLine={false} />
          <YAxis type="category" dataKey="label" orientation="right" width={132} tick={<StartTick />} tickLine={false} axisLine={false} interval={0} />
          <Tooltip cursor={{ fill: tokens['--chart-cursor'] }} content={<ChartTooltip />} isAnimationActive={false} />
          {series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              stackId={stacked ? 'all' : undefined}
              fill={s.colour}
              barSize={barSize}
              isAnimationActive={false}
              radius={stacked ? (i === series.length - 1 ? [radius, 0, 0, radius] : 0) : [radius, 0, 0, radius]}
              cursor={onSelect ? 'pointer' : undefined}
              onClick={onSelect ? (_data: unknown, index: number) => onSelect(index) : undefined}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/**
 * Vertical columns along a sequence (weeks), oldest on the right, the value
 * axis on the right. `onSelect` gets the column index.
 */
export function Columns({
  rows,
  series,
  onSelect,
  label,
  highlight,
}: {
  rows: readonly BarRow[]
  series: readonly SeriesSpec[]
  onSelect?: (index: number) => void
  label: string
  /** The category to emphasise (this week). */
  highlight?: string
}) {
  const tokens = useChartTokens()
  const radius = num(tokens['--chart-radius'], 4)
  return (
    <div className="chart chart--tall" role="img" aria-label={label} data-chart="columns">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows as BarRow[]} margin={{ top: 8, right: 4, bottom: 20, left: 4 }} barCategoryGap="20%">
          <CartesianGrid vertical={false} stroke={tokens['--chart-grid']} strokeDasharray="3 3" />
          <XAxis
            dataKey="label"
            reversed
            interval="preserveStartEnd"
            tickLine={false}
            stroke={tokens['--chart-grid']}
            tick={(props: TickProps) => {
              const value = String(props.payload?.value ?? '')
              return (
                <g>
                  <LatinTick {...props} payload={{ value: value.slice(5) }} />
                  {value === highlight ? <circle cx={Number(props.x)} cy={Number(props.y) + 22} r={2.5} fill={tokens['--chart-axis']} /> : null}
                </g>
              )
            }}
          />
          <YAxis orientation="right" allowDecimals={false} width={36} tick={<LatinTick anchor="start" dy={4} />} tickLine={false} axisLine={false} />
          <Tooltip cursor={{ fill: tokens['--chart-cursor'] }} content={<ChartTooltip />} isAnimationActive={false} />
          {series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              stackId="all"
              fill={s.colour}
              isAnimationActive={false}
              radius={i === series.length - 1 ? [radius, radius, 0, 0] : 0}
              cursor={onSelect ? 'pointer' : undefined}
              onClick={onSelect ? (_data: unknown, index: number) => onSelect(index) : undefined}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** One line along the groups (first appearance order), right to left. */
export function LineSeries({ rows, colour, name, onSelect, label }: { rows: readonly BarRow[]; colour: string; name: string; onSelect?: (index: number) => void; label: string }) {
  const tokens = useChartTokens()
  return (
    <div className="chart chart--tall" role="img" aria-label={label} data-chart="line">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={rows as BarRow[]}
          margin={{ top: 12, right: 4, bottom: 20, left: 12 }}
          onClick={
            onSelect
              ? (state: { activeTooltipIndex?: unknown }) => {
                  const i = Number(state?.activeTooltipIndex)
                  if (Number.isInteger(i) && i >= 0) onSelect(i)
                }
              : undefined
          }
        >
          <CartesianGrid vertical={false} stroke={tokens['--chart-grid']} strokeDasharray="3 3" />
          <XAxis
            dataKey="label"
            reversed
            interval="preserveStartEnd"
            tickLine={false}
            stroke={tokens['--chart-grid']}
            tick={(props: TickProps) => (
              <text x={Number(props.x)} y={Number(props.y)} dy={12} textAnchor="middle" direction="rtl" className="chart__tick chart__tick--label">
                {shorten(String(props.payload?.value ?? ''), 12)}
              </text>
            )}
          />
          <YAxis orientation="right" width={48} tick={<LatinTick anchor="start" dy={4} />} tickLine={false} axisLine={false} />
          <Tooltip content={<ChartTooltip />} isAnimationActive={false} />
          <Line type="monotone" dataKey="value" name={name} stroke={colour} strokeWidth={2.5} dot={{ r: 3.5, fill: colour }} activeDot={{ r: 6, cursor: 'pointer' }} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

export interface PieDatum {
  label: string
  value: number
  colour: string
}

/** A pie, or a donut with `donut`. Twelve o'clock, counter-clockwise. */
export function PieRing({ data, donut, onSelect, label, centre }: { data: readonly PieDatum[]; donut: boolean; onSelect?: (index: number) => void; label: string; centre?: ReactNode }) {
  const tokens = useChartTokens()
  return (
    <div className="chart chart--pie" role="img" aria-label={label} data-chart={donut ? 'donut' : 'pie'}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Tooltip content={<ChartTooltip title={(_l, payload) => <bdi>{String(payload[0]?.name ?? '')}</bdi>} />} isAnimationActive={false} />
          <Pie
            data={data as PieDatum[]}
            dataKey="value"
            nameKey="label"
            startAngle={90}
            endAngle={450}
            innerRadius={donut ? '58%' : 0}
            outerRadius="92%"
            paddingAngle={donut ? 2 : 0}
            stroke={tokens['--color-surface']}
            strokeWidth={2}
            isAnimationActive={false}
            cursor={onSelect ? 'pointer' : undefined}
            onClick={onSelect ? (_data: unknown, index: number) => onSelect(index) : undefined}
          >
            {data.map((d, i) => (
              <Cell key={i} fill={d.colour} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      {donut && centre ? <div className="chart__centre">{centre}</div> : null}
    </div>
  )
}
