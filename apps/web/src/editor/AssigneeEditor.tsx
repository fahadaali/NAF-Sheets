// The assignee cell editor (spec §5.2, §8.1, §8.2): a searchable multi-select
// with name and avatar, in the sections «أعضاء المشروع», «أعضاء الحساب (خارج
// المشروع)», «جهات خارجية», then «إضافة شخص جديد».
//
// OPEN: it opens as a dialog over the grid, not as a dropdown anchored to the
// cell (apps/web/OPEN_QUESTIONS.md #39). It writes the cell's text only (the
// names, as sheet-model's `readTasks` reads them); the server resolves them.

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Building2, Check, LoaderCircle, Plus, Search, TriangleExclamationPoint, UserPlus, UserRound, X } from 'lucide-react'
import type { AssigneeOptionsResponse, BcPerson, ExternalContact } from '@naf-sheets/shared'
import { api, ApiRequestError, errorMessage } from '../lib/api'
import { Notice } from '../components/Notice'
import { t } from '../strings'
import { ambiguousNames, chipsOf, choiceKey, choiceName, filterOptions, formatAssigneeCell, validateChoices, type Chip, type Choice } from '../sync/assignees'
import { normalizeName, splitAssigneeText } from '@naf-sheets/sheet-model'
import type { AssigneeTarget } from './sync-layer'

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; options: AssigneeOptionsResponse }
type Selected = Choice | { kind: 'name'; name: string }
type View = { kind: 'list' } | { kind: 'grant'; person: BcPerson; busy: boolean; error: string | null; forbidden: boolean } | { kind: 'new' }

const selectedName = (s: Selected) => (s.kind === 'name' ? s.name : choiceName(s))
const selectedKey = (s: Selected) => (s.kind === 'name' ? `n:${normalizeName(s.name)}` : choiceKey(s))

function initialSelection(text: string, options: AssigneeOptionsResponse): Selected[] {
  const out: Selected[] = []
  for (const name of splitAssigneeText(text)) {
    const same = (n: string) => normalizeName(n) === normalizeName(name)
    const project = options.projectPeople.find((p) => same(p.name))
    const account = options.accountPeople.find((p) => same(p.name))
    const external = options.externals.find((e) => same(e.name))
    if (project) out.push({ kind: 'person', person: project, inProject: true })
    else if (account) out.push({ kind: 'person', person: account, inProject: false })
    else if (external) out.push({ kind: 'external', contact: external })
    else out.push({ kind: 'name', name })
  }
  return out
}

function Avatar({ url, external }: { url: string | null; external?: boolean }) {
  if (url) return <img className="avatar" src={url} alt="" loading="lazy" referrerPolicy="no-referrer" />
  const Icon = external ? Building2 : UserRound
  return (
    <span className="avatar avatar--icon" aria-hidden="true">
      <Icon className="icon" />
    </span>
  )
}

export function AssigneeEditor({
  target,
  workbookId,
  projectId,
  onSave,
  onClose,
}: {
  target: AssigneeTarget
  workbookId: string
  projectId: number | null
  /** Writes the cell; '' empties it. Resolves false when the write was refused. */
  onSave: (text: string) => boolean
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const ids = useId()
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [selected, setSelected] = useState<Selected[]>([])
  const [query, setQuery] = useState('')
  const [view, setView] = useState<View>({ kind: 'list' })
  const [error, setError] = useState<string | null>(null)
  const [needsFollower, setNeedsFollower] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    ref.current?.showModal()
    const controller = new AbortController()
    api.getAssigneeOptions(workbookId, controller.signal).then(
      (options) => {
        setLoad({ kind: 'ready', options })
        setSelected(initialSelection(target.text, options))
      },
      (e: unknown) => {
        if (!controller.signal.aborted) setLoad({ kind: 'error', message: errorMessage(e) })
      },
    )
    return () => controller.abort()
  }, [workbookId, target.text])

  const options = load.kind === 'ready' ? load.options : null
  const sections = useMemo(() => (options ? filterOptions(options, query) : null), [options, query])
  const keys = new Set(selected.map(selectedKey))
  const auto = target.auto && !dirty
  const chips = selected.map((s): Chip & { key: string } => {
    const key = selectedKey(s)
    if (s.kind === 'person') return { key, name: s.person.name, kind: s.inProject ? 'project' : 'account', auto, avatarUrl: s.person.avatarUrl, detail: s.person.email }
    if (s.kind === 'external') return { key, name: s.contact.name, kind: 'external', auto, avatarUrl: null, detail: s.contact.organization }
    const [chip] = chipsOf(s.name, options, auto)
    return { key, ...(chip ?? { name: s.name, kind: 'unknown', auto, avatarUrl: null, detail: null }) }
  })

  const toggle = (choice: Choice) => {
    setError(null)
    const key = choiceKey(choice)
    if (keys.has(key)) {
      setSelected((list) => list.filter((s) => selectedKey(s) !== key))
      setDirty(true)
      return
    }
    // §8.2 case 1: an account member must be added to the project first.
    if (choice.kind === 'person' && !choice.inProject) {
      setView({ kind: 'grant', person: choice.person, busy: false, error: null, forbidden: false })
      return
    }
    setSelected((list) => [...list, choice])
    setDirty(true)
  }

  const remove = (key: string) => {
    setSelected((list) => list.filter((s) => selectedKey(s) !== key))
    setDirty(true)
  }

  const grant = async (person: BcPerson) => {
    setView({ kind: 'grant', person, busy: true, error: null, forbidden: false })
    try {
      const next = await api.grantProjectPerson(workbookId, { bcPersonId: person.id })
      setLoad({ kind: 'ready', options: next })
      const member = next.projectPeople.find((p) => p.id === person.id) ?? person
      setSelected((list) => [...list.filter((s) => !(s.kind === 'person' && s.person.id === person.id)), { kind: 'person', person: member, inProject: true }])
      setDirty(true)
      setView({ kind: 'list' })
    } catch (e: unknown) {
      const forbidden = e instanceof ApiRequestError && e.status === 403
      setView({ kind: 'grant', person, busy: false, forbidden, error: forbidden ? (e.message || t.assignee.grantForbidden) : errorMessage(e) })
    }
  }

  const save = () => {
    const resolved = selected.filter((s): s is Choice => s.kind !== 'name')
    const problem = validateChoices(resolved)
    setNeedsFollower(problem !== null)
    if (problem) {
      setError(problem)
      return
    }
    const text = formatAssigneeCell(selected.map(selectedName), target.multipleList)
    if (onSave(text)) onClose()
  }

  const makeAutomatic = () => {
    if (onSave('')) onClose()
  }

  const ambiguous = options ? ambiguousNames(selected.filter((s): s is Choice => s.kind !== 'name'), options) : []

  return (
    <dialog
      ref={ref}
      className="dialog picker"
      aria-labelledby={`${ids}-title`}
      onClose={onClose}
      data-testid="assignee-editor"
    >
      <div className="dialog__body">
        <div className="picker__head">
          <h2 id={`${ids}-title`}>{t.assignee.title}</h2>
          <button type="button" className="icon-button" aria-label={t.assignee.cancel} title={t.assignee.cancel} onClick={onClose}>
            <X className="icon" aria-hidden="true" />
          </button>
        </div>
        {target.title ? (
          <p className="muted small">
            <bdi>{target.title}</bdi>
          </p>
        ) : null}

        {load.kind === 'loading' ? (
          <p className="muted with-icon" role="status">
            <LoaderCircle className="icon spin" aria-hidden="true" />
            {t.assignee.loading}
          </p>
        ) : null}
        {load.kind === 'error' ? (
          <Notice tone="danger">
            <p>{load.message}</p>
          </Notice>
        ) : null}

        {options && view.kind === 'grant' ? (
          <GrantView
            person={view.person}
            projectId={projectId}
            busy={view.busy}
            error={view.error}
            forbidden={view.forbidden}
            onGrant={() => void grant(view.person)}
            onBack={() => setView({ kind: 'list' })}
          />
        ) : null}

        {options && view.kind === 'new' ? (
          <NewExternalView
            onCreated={(contact) => {
              setLoad({ kind: 'ready', options: { ...options, externals: [...options.externals, contact] } })
              setSelected((list) => [...list, { kind: 'external', contact }])
              setDirty(true)
              setView({ kind: 'list' })
            }}
            onBack={() => setView({ kind: 'list' })}
          />
        ) : null}

        {options && view.kind === 'list' ? (
          <>
            {target.auto && !dirty ? (
              <p className="picker__hint small" data-testid="assignee-auto-hint">
                {t.assignee.autoHint}
              </p>
            ) : null}
            <section aria-labelledby={`${ids}-selected`} className="stack-tight">
              <h3 id={`${ids}-selected`} className="picker__label">
                {t.assignee.selected}
              </h3>
              {chips.length === 0 ? (
                <p className="muted small">{t.assignee.none}</p>
              ) : (
                <ul className="chips" data-testid="assignee-chips">
                  {chips.map((chip) => {
                    const { key } = chip
                    const warning = chip.kind === 'account' ? t.assignee.removedMember : chip.kind === 'unknown' ? t.assignee.unknown : null
                    return (
                      <li
                        key={key}
                        className={`chip chip--${chip.kind}${chip.auto ? ' chip--auto' : ''}`}
                        data-kind={chip.kind}
                        data-auto={chip.auto ? 'true' : 'false'}
                        title={chip.auto ? t.assignee.autoTooltip : (warning ?? undefined)}
                      >
                        <Avatar url={chip.avatarUrl} external={chip.kind === 'external'} />
                        <bdi>{chip.name}</bdi>
                        {chip.kind === 'external' ? <span className="chip__tag">{t.assignee.externalTag}</span> : null}
                        {chip.auto ? <span className="chip__tag">{t.assignee.autoTag}</span> : null}
                        {warning ? <TriangleExclamationPoint className="icon chip__warn" aria-label={warning} /> : null}
                        <button type="button" className="chip__remove" aria-label={t.assignee.remove(chip.name)} onClick={() => remove(key)}>
                          <X className="icon" aria-hidden="true" />
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
              {chips.some((c) => c.kind === 'account') ? <p className="field-hint">{t.assignee.removedMember}</p> : null}
              {chips.some((c) => c.kind === 'unknown') ? <p className="field-hint">{t.assignee.unknown}</p> : null}
            </section>

            <div className="search picker__search">
              <Search className="icon" aria-hidden="true" />
              <input
                type="search"
                aria-label={t.assignee.searchLabel}
                placeholder={t.assignee.searchPlaceholder}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
              />
            </div>

            <div className="picker__list" role="group" aria-label={t.assignee.title}>
              {projectId === null ? <p className="muted small">{t.assignee.noProject}</p> : null}
              <OptionSection title={t.assignee.sections.project} testId="section-project">
                {sections?.project.map((p) => (
                  <OptionRow key={p.id} checked={keys.has(`p:${p.id}`)} onToggle={() => toggle({ kind: 'person', person: p, inProject: true })} name={p.name} detail={p.email} avatar={<Avatar url={p.avatarUrl} />} />
                ))}
              </OptionSection>
              <OptionSection title={t.assignee.sections.account} testId="section-account">
                {sections?.account.map((p) => (
                  <OptionRow key={p.id} checked={keys.has(`p:${p.id}`)} onToggle={() => toggle({ kind: 'person', person: p, inProject: false })} name={p.name} detail={p.email} avatar={<Avatar url={p.avatarUrl} />} />
                ))}
              </OptionSection>
              <OptionSection title={t.assignee.sections.externals} testId="section-externals">
                {sections?.externals.map((e) => (
                  <OptionRow
                    key={e.id}
                    checked={keys.has(`e:${e.id}`)}
                    onToggle={() => toggle({ kind: 'external', contact: e })}
                    name={e.name}
                    detail={e.organization}
                    avatar={<Avatar url={null} external />}
                    tag={t.assignee.externalTag}
                  />
                ))}
              </OptionSection>
              {sections && sections.project.length + sections.account.length + sections.externals.length === 0 ? <p className="muted small">{t.assignee.noMatches}</p> : null}
              <button type="button" className="button button--ghost picker__add" onClick={() => setView({ kind: 'new' })} data-testid="assignee-add-new">
                <Plus className="icon" aria-hidden="true" />
                {t.assignee.addNew}
              </button>
            </div>

            {ambiguous.length > 0 ? (
              <Notice tone="warning">
                <p>{t.assignee.ambiguous(ambiguous.join('، '))}</p>
              </Notice>
            ) : null}
            {error ? (
              <Notice tone="danger" testId="assignee-error">
                <p>{error}</p>
                {needsFollower ? <p>{t.assignee.followerHint}</p> : null}
              </Notice>
            ) : null}

            <div className="dialog__actions">
              <button type="button" className="button button--primary" onClick={save} data-testid="assignee-save">
                <Check className="icon" aria-hidden="true" />
                {t.assignee.save}
              </button>
              <button type="button" className="button" onClick={onClose}>
                {t.assignee.cancel}
              </button>
              {target.level === 0 && !target.auto ? (
                <button type="button" className="button button--ghost" onClick={makeAutomatic} title={t.assignee.makeAutoHint} data-testid="assignee-make-auto">
                  {t.assignee.makeAuto}
                </button>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </dialog>
  )
}

function OptionSection({ title, testId, children }: { title: string; testId: string; children: ReactNode[] | undefined }) {
  if (!children || children.length === 0) return null
  return (
    <section className="picker__section" data-testid={testId}>
      <h3 className="picker__label">{title}</h3>
      <ul className="picker__options">{children}</ul>
    </section>
  )
}

function OptionRow({ checked, onToggle, name, detail, avatar, tag }: { checked: boolean; onToggle: () => void; name: string; detail: string | null; avatar: ReactNode; tag?: string }) {
  return (
    <li>
      <label className="picker__option">
        <input type="checkbox" checked={checked} onChange={onToggle} />
        {avatar}
        <span className="picker__name">
          <bdi>{name}</bdi>
          {detail ? (
            <span className="muted small">
              <bdi>{detail}</bdi>
            </span>
          ) : null}
        </span>
        {tag ? <span className="chip__tag">{tag}</span> : null}
      </label>
    </li>
  )
}

function GrantView({
  person,
  projectId,
  busy,
  error,
  forbidden,
  onGrant,
  onBack,
}: {
  person: BcPerson
  projectId: number | null
  busy: boolean
  error: string | null
  forbidden: boolean
  onGrant: () => void
  onBack: () => void
}) {
  return (
    <section className="stack" role="alertdialog" aria-label={t.assignee.grantTitle} data-testid="assignee-grant">
      <h3 className="with-icon">
        <UserPlus className="icon" aria-hidden="true" />
        {t.assignee.grantTitle}
      </h3>
      <p>{t.assignee.grantBody(person.name, projectId === null ? '—' : String(projectId))}</p>
      {error ? (
        <Notice tone="danger" testId="assignee-grant-error">
          <p>{error}</p>
        </Notice>
      ) : null}
      <div className="dialog__actions">
        {!forbidden ? (
          <button type="button" className="button button--primary" onClick={onGrant} disabled={busy}>
            {busy ? <LoaderCircle className="icon spin" aria-hidden="true" /> : null}
            {busy ? t.assignee.granting : t.assignee.grant}
          </button>
        ) : (
          // OPEN: «أرسل طلباً» needs an endpoint the contract does not have (OPEN_QUESTIONS.md #40).
          <button type="button" className="button" disabled title={t.assignee.requestUnavailable}>
            {t.assignee.requestAccess}
          </button>
        )}
        <button type="button" className="button" onClick={onBack} disabled={busy}>
          {t.assignee.back}
        </button>
      </div>
      {forbidden ? <p className="field-hint">{t.assignee.requestUnavailable}</p> : null}
    </section>
  )
}

function NewExternalView({ onCreated, onBack }: { onCreated: (contact: ExternalContact) => void; onBack: () => void }) {
  const ids = useId()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', organization: '', email: '', phone: '' })
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }))

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    const name = form.name.trim()
    if (name === '') {
      setError(t.assignee.nameRequired)
      return
    }
    setBusy(true)
    setError(null)
    const value = (s: string) => (s.trim() === '' ? null : s.trim())
    try {
      onCreated(await api.createExternalContact({ name, organization: value(form.organization), email: value(form.email), phone: value(form.phone) }))
    } catch (err: unknown) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <form className="stack" onSubmit={(e) => void submit(e)} data-testid="assignee-new" noValidate>
      <h3>{t.assignee.newPersonTitle}</h3>
      <fieldset className="choices">
        <div className="choice">
          <input type="radio" id={`${ids}-ext`} name={`${ids}-kind`} defaultChecked />
          <label htmlFor={`${ids}-ext`}>
            <Building2 className="icon" aria-hidden="true" />
            <span>
              <strong>{t.assignee.kindExternal}</strong>
              <span className="choice__hint">{t.assignee.kindExternalHint}</span>
            </span>
          </label>
        </div>
        {/* OPEN: inviting to Basecamp (§8.2 case 2) has no endpoint yet (OPEN_QUESTIONS.md #40). */}
        <div className="choice">
          <input type="radio" id={`${ids}-inv`} name={`${ids}-kind`} disabled />
          <label htmlFor={`${ids}-inv`}>
            <UserPlus className="icon" aria-hidden="true" />
            <span>
              <strong>{t.assignee.kindInvite}</strong>
              <span className="choice__hint">{t.assignee.kindInviteHint}</span>
            </span>
          </label>
        </div>
      </fieldset>
      <div className="field">
        <label htmlFor={`${ids}-name`}>{t.assignee.name}</label>
        <input id={`${ids}-name`} value={form.name} onChange={set('name')} aria-invalid={error === t.assignee.nameRequired} autoFocus />
      </div>
      <div className="field">
        <label htmlFor={`${ids}-org`}>
          {t.assignee.organization} <span className="muted small">{t.assignee.optional}</span>
        </label>
        <input id={`${ids}-org`} value={form.organization} onChange={set('organization')} />
      </div>
      <div className="field">
        <label htmlFor={`${ids}-email`}>
          {t.assignee.email} <span className="muted small">{t.assignee.optional}</span>
        </label>
        <input id={`${ids}-email`} type="email" dir="ltr" value={form.email} onChange={set('email')} />
      </div>
      <div className="field">
        <label htmlFor={`${ids}-phone`}>
          {t.assignee.phone} <span className="muted small">{t.assignee.optional}</span>
        </label>
        <input id={`${ids}-phone`} type="tel" dir="ltr" value={form.phone} onChange={set('phone')} />
      </div>
      {error ? (
        <Notice tone="danger">
          <p>{error}</p>
        </Notice>
      ) : null}
      <div className="dialog__actions">
        <button type="submit" className="button button--primary" disabled={busy}>
          {busy ? <LoaderCircle className="icon spin" aria-hidden="true" /> : <Plus className="icon" aria-hidden="true" />}
          {busy ? t.assignee.creating : t.assignee.create}
        </button>
        <button type="button" className="button" onClick={onBack} disabled={busy}>
          {t.assignee.back}
        </button>
      </div>
    </form>
  )
}
