// «المظهر» (admins only): the platform's palette — the accent, the neutrals
// and the chart series — with a live preview and «استعادة الافتراضي».
//
// The defaults are theme.css's values (read from the stylesheet, never
// written here); what is saved is only what differs from them
// (PUT /api/admin/appearance), and it applies to everyone at their next load
// (src/App.tsx) and to this browser at once. Values are `#rrggbb` only; a
// contrast below WCAG AA warns but does not block the save.

import { useEffect, useId, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { CircleCheck, LoaderCircle, Palette, RotateCcw, TriangleExclamationPoint } from 'lucide-react'
import type { AppearancePalette, AppearanceToken, CurrentUser } from '@naf-sheets/shared'
import { APPEARANCE_TOKENS, APPEARANCE_TOKEN_NAMES, HEX_COLOUR, SERIES_TOKENS, contrastWarnings } from '@naf-sheets/shared'
import { AdminPage } from '../components/AdminPage'
import { Notice } from '../components/Notice'
import { api, errorMessage, isAbortError } from '../lib/api'
import { applyPalette, defaultPalette } from '../lib/theme-colors'
import { t } from '../strings'

const ta = t.appearance

const ACCENT: readonly AppearanceToken[] = ['accent', 'accentContrast']
const NEUTRALS: readonly AppearanceToken[] = ['page', 'surface', 'surfaceMuted', 'border', 'text', 'textMuted']

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready' }

/** Only the values that differ from the defaults are stored. */
export function overridesOf(values: AppearancePalette, defaults: AppearancePalette): AppearancePalette {
  const out: AppearancePalette = {}
  for (const name of APPEARANCE_TOKEN_NAMES) {
    const v = values[name]?.toLowerCase()
    if (v && HEX_COLOUR.test(v) && v !== defaults[name]?.toLowerCase()) out[name] = v
  }
  return out
}

export function AppearanceScreen({ user, userSettled }: { user: CurrentUser | null; userSettled: boolean }) {
  return (
    <AdminPage user={user} userSettled={userSettled} title={ta.title} screen="appearance">
      <AppearanceEditor />
    </AdminPage>
  )
}

function AppearanceEditor() {
  const defaults = useMemo(() => defaultPalette(), [])
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  // What the form shows (text as typed); `saved` is what the server holds now.
  const [values, setValues] = useState<Record<AppearanceToken, string>>(() => fill(defaults, {}))
  const [saved, setSaved] = useState<AppearancePalette>({})
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setLoad({ kind: 'loading' })
    api.getAppearance(controller.signal).then(
      (res) => {
        setSaved(res.palette)
        setValues(fill(defaults, res.palette))
        setLoad({ kind: 'ready' })
      },
      (e: unknown) => {
        if (!isAbortError(e)) setLoad({ kind: 'error', message: errorMessage(e) })
      },
    )
    return () => controller.abort()
  }, [defaults, attempt])

  const invalid = APPEARANCE_TOKEN_NAMES.filter((n) => !HEX_COLOUR.test(values[n]))
  const effective: AppearancePalette = {}
  for (const n of APPEARANCE_TOKEN_NAMES) effective[n] = HEX_COLOUR.test(values[n]) ? values[n].toLowerCase() : defaults[n]
  const warnings = contrastWarnings(effective)
  const overrides = overridesOf(effective, defaults)
  const dirty = JSON.stringify(overrides) !== JSON.stringify(overridesOf({ ...defaults, ...saved }, defaults))

  const save = async (palette: AppearancePalette, done: string) => {
    setSaving(true)
    setMessage(null)
    try {
      const res = await api.putAppearance(palette)
      setSaved(res.palette)
      setValues(fill(defaults, res.palette))
      applyPalette(res.palette)
      setMessage({ tone: 'info', text: done })
    } catch (e) {
      setMessage({ tone: 'danger', text: errorMessage(e) })
    } finally {
      setSaving(false)
    }
  }

  if (load.kind === 'loading') {
    return (
      <div className="panel panel--plain" role="status">
        <LoaderCircle className="panel__icon spin" aria-hidden="true" />
        <p>{ta.loading}</p>
      </div>
    )
  }
  if (load.kind === 'error') {
    return (
      <Notice
        tone="danger"
        title={ta.loadFailed}
        actions={
          <button type="button" className="button button--small" onClick={() => setAttempt((n) => n + 1)}>
            {t.dashboard.retry}
          </button>
        }
      >
        <p>{load.message}</p>
      </Notice>
    )
  }

  // The preview reads the form's values through the same custom properties the app uses.
  const scope = {} as Record<string, string>
  for (const n of APPEARANCE_TOKEN_NAMES) scope[APPEARANCE_TOKENS[n]] = effective[n] ?? ''

  const set = (name: AppearanceToken, value: string) => setValues((v) => ({ ...v, [name]: value }))

  return (
    <div className="appearance" data-testid="appearance">
      <p className="lead">{ta.lead}</p>
      <div className="appearance__layout">
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault()
            if (invalid.length === 0) void save(overrides, ta.saved)
          }}
        >
          <ColourGroup title={ta.accentSection} names={ACCENT} values={values} defaults={defaults} onChange={set} />
          <ColourGroup title={ta.neutralSection} names={NEUTRALS} values={values} defaults={defaults} onChange={set} />
          <ColourGroup title={ta.seriesSection} hint={ta.seriesHint} names={SERIES_TOKENS} values={values} defaults={defaults} onChange={set} />

          {message ? (
            <Notice tone={message.tone} testId="appearance-message">
              <p>{message.text}</p>
            </Notice>
          ) : null}

          <div className="card__actions appearance__actions">
            <button type="submit" className="button button--primary" disabled={saving || invalid.length > 0 || !dirty} data-testid="appearance-save">
              {saving ? <LoaderCircle className="icon spin" aria-hidden="true" /> : null}
              {saving ? ta.saving : ta.save}
            </button>
            {dirty ? (
              <span className="muted small" data-testid="appearance-dirty">
                {ta.unsaved}
              </span>
            ) : null}
            {confirmReset ? (
              <span className="inline-row" role="group" aria-label={ta.reset}>
                <span className="small">{ta.resetConfirm}</span>
                <button
                  type="button"
                  className="button button--small button--danger"
                  onClick={() => {
                    setConfirmReset(false)
                    void save({}, ta.resetDone)
                  }}
                  data-testid="appearance-reset-confirm"
                >
                  {ta.resetYes}
                </button>
                <button type="button" className="button button--small" onClick={() => setConfirmReset(false)}>
                  {ta.resetCancel}
                </button>
              </span>
            ) : (
              <button type="button" className="button" onClick={() => setConfirmReset(true)} disabled={saving} data-testid="appearance-reset">
                <RotateCcw className="icon" aria-hidden="true" />
                {ta.reset}
              </button>
            )}
          </div>
        </form>

        <aside className="appearance__preview" aria-labelledby="appearance-preview-title">
          <h2 id="appearance-preview-title" className="with-icon">
            <Palette className="icon" aria-hidden="true" />
            {ta.preview}
          </h2>
          <Preview scope={scope} effective={effective} />
          <Contrast warnings={warnings} />
        </aside>
      </div>
    </div>
  )
}

function fill(defaults: AppearancePalette, palette: AppearancePalette): Record<AppearanceToken, string> {
  const out = {} as Record<AppearanceToken, string>
  for (const n of APPEARANCE_TOKEN_NAMES) out[n] = palette[n] ?? defaults[n] ?? ''
  return out
}

function ColourGroup({
  title,
  hint,
  names,
  values,
  defaults,
  onChange,
}: {
  title: string
  hint?: string
  names: readonly AppearanceToken[]
  values: Record<AppearanceToken, string>
  defaults: AppearancePalette
  onChange: (name: AppearanceToken, value: string) => void
}) {
  return (
    <fieldset className="card colour-group">
      <legend className="card__legend">{title}</legend>
      {hint ? <p className="muted small">{hint}</p> : null}
      <div className="colour-grid">
        {names.map((name) => (
          <ColourField key={name} name={name} value={values[name]} fallback={defaults[name] ?? ''} onChange={(v) => onChange(name, v)} />
        ))}
      </div>
    </fieldset>
  )
}

function ColourField({ name, value, fallback, onChange }: { name: AppearanceToken; value: string; fallback: string; onChange: (value: string) => void }) {
  const id = useId()
  const label = ta.tokens[name] ?? name
  const valid = HEX_COLOUR.test(value)
  return (
    <div className="colour-field" data-testid={`colour-${name}`}>
      <label htmlFor={`${id}-hex`} className="colour-field__label">
        {label}
      </label>
      <div className="colour-field__inputs">
        <input
          type="color"
          className="colour-field__picker"
          value={(valid ? value : fallback).toLowerCase()}
          onChange={(e) => onChange(e.target.value)}
          aria-label={ta.pickLabel(label)}
        />
        <input
          id={`${id}-hex`}
          className="colour-field__hex"
          dir="ltr"
          value={value}
          spellCheck={false}
          maxLength={7}
          onChange={(e) => onChange(e.target.value.trim())}
          aria-invalid={!valid}
          aria-describedby={!valid ? `${id}-error` : undefined}
          aria-label={ta.hexLabel(label)}
          data-testid={`hex-${name}`}
        />
      </div>
      {!valid ? (
        <span className="field-error" id={`${id}-error`}>
          {ta.invalidHex}
        </span>
      ) : null}
    </div>
  )
}

function Preview({ scope, effective }: { scope: Record<string, string>; effective: AppearancePalette }) {
  const heights = [72, 54, 88, 40, 64, 30, 78, 48]
  return (
    <div className="theme-scope appearance-sample" style={scope as CSSProperties} data-testid="appearance-preview">
      <div className="appearance-sample__card">
        <p className="appearance-sample__label">{t.dashboard.kpi.completion}</p>
        <p className="appearance-sample__value">
          <bdi dir="ltr" className="num">
            {ta.previewValue}
          </bdi>
        </p>
        <p className="appearance-sample__muted">{ta.previewBody}</p>
        <div className="appearance-sample__bars" aria-hidden="true">
          {SERIES_TOKENS.map((n, i) => (
            <span key={n} className="appearance-sample__bar" style={{ blockSize: `${heights[i]}%`, background: effective[n] }} />
          ))}
        </div>
        <div className="inline-row">
          <button type="button" className="button button--primary button--small" tabIndex={-1}>
            {ta.previewButton}
          </button>
          <a className="appearance-sample__link" href="#appearance-preview-title" tabIndex={-1}>
            {ta.previewLink}
          </a>
        </div>
      </div>
      <ul className="legend legend--inline appearance-sample__legend">
        {SERIES_TOKENS.map((n, i) => (
          <li key={n} className="legend__item">
            <span className="swatch swatch--sm" style={{ background: effective[n] }} aria-hidden="true" />
            {ta.previewSeries(String(i + 1))}
          </li>
        ))}
      </ul>
    </div>
  )
}

function Contrast({ warnings }: { warnings: ReturnType<typeof contrastWarnings> }) {
  if (warnings.length === 0) {
    return (
      <p className="with-icon small contrast-ok" data-testid="contrast-ok">
        <CircleCheck className="icon" aria-hidden="true" />
        {ta.contrastOk}
      </p>
    )
  }
  const name = (n: AppearanceToken) => ta.tokens[n] ?? n
  return (
    <div className="notice notice--warning" role="status" data-testid="contrast-warnings">
      <TriangleExclamationPoint className="icon" aria-hidden="true" />
      <div className="notice__body">
        <p className="notice__title">{ta.contrastTitle}</p>
        <p>{ta.contrastBody}</p>
        <ul>
          {warnings.map((w) => (
            <li key={`${w.foreground}-${w.background}`}>
              {name(w.foreground)} {ta.contrastOn} {name(w.background)}:{' '}
              <bdi dir="ltr" className="num">
                {w.ratio.toFixed(2)}:1
              </bdi>{' '}
              ({ta.contrastRequired}{' '}
              <bdi dir="ltr" className="num">
                {w.minimum}:1
              </bdi>
              )
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
