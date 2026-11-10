// The assignee cell (spec §5.2, §8.1, §8.2): which people its text names,
// and the text the editor writes back.
//
// The cell holds names only; the server reads them with sheet-model's
// `readTasks` (`splitAssigneeText`, then name matching against the people
// cache and the external contacts). So the editor writes exactly what that
// reader splits: Univer's JSON list in a multiple-choice cell, otherwise the
// names joined with the Arabic comma (sheet-model `formatAssignees`).

import { normalizeName, splitAssigneeText } from '@naf-sheets/sheet-model'
import { ERROR_MESSAGES } from '@naf-sheets/sync-engine'
import type { AssigneeOptionsResponse, BcPerson, ExternalContact } from '@naf-sheets/shared'

export type ChipKind =
  /** A member of the linked Basecamp project. */
  | 'project'
  /** In the Basecamp account but not in the project (removed from it, or never added): not assigned in Basecamp. */
  | 'account'
  | 'external'
  /** Nobody of that name: the server reports it as `unknown_assignee`. */
  | 'unknown'

export interface Chip {
  name: string
  kind: ChipKind
  /** Shown with a dotted border: computed from the subtasks (§8.1). */
  auto: boolean
  avatarUrl: string | null
  detail: string | null
}

export type Choice = { kind: 'person'; person: BcPerson; inProject: boolean } | { kind: 'external'; contact: ExternalContact }

export const choiceName = (c: Choice): string => (c.kind === 'person' ? c.person.name : c.contact.name)
export const choiceKey = (c: Choice): string => (c.kind === 'person' ? `p:${c.person.id}` : `e:${c.contact.id}`)

const sameName = (a: string, b: string) => normalizeName(a) === normalizeName(b)

/**
 * The cell's names, matched against the options in the order of the §8.2 sections.
 * OPEN: `auto` is per row, so every name of an automatic row is automatic (#41);
 * an account member outside the project reads as removed from it (#42).
 */
export function chipsOf(text: string, options: AssigneeOptionsResponse | null, auto: boolean): Chip[] {
  return splitAssigneeText(text).map((name) => {
    const project = options?.projectPeople.find((p) => sameName(p.name, name))
    if (project) return { name, kind: 'project', auto, avatarUrl: project.avatarUrl, detail: project.email }
    const account = options?.accountPeople.find((p) => sameName(p.name, name))
    if (account) return { name, kind: 'account', auto, avatarUrl: account.avatarUrl, detail: account.email }
    const external = options?.externals.find((e) => sameName(e.name, name))
    if (external) return { name, kind: 'external', auto, avatarUrl: null, detail: external.organization }
    return { name, kind: 'unknown', auto, avatarUrl: null, detail: null }
  })
}

/** What the cell's names select when the editor opens; names that match nobody are dropped. */
export function choicesOf(text: string, options: AssigneeOptionsResponse): Choice[] {
  const out: Choice[] = []
  for (const name of splitAssigneeText(text)) {
    const project = options.projectPeople.find((p) => sameName(p.name, name))
    if (project) {
      out.push({ kind: 'person', person: project, inProject: true })
      continue
    }
    const account = options.accountPeople.find((p) => sameName(p.name, name))
    if (account) {
      out.push({ kind: 'person', person: account, inProject: false })
      continue
    }
    const external = options.externals.find((e) => sameName(e.name, name))
    if (external) out.push({ kind: 'external', contact: external })
  }
  return out
}

/** The cell text for these names: sheet-model `formatAssignees`. */
export function formatAssigneeCell(names: readonly string[], multipleList: boolean): string {
  if (names.length === 0) return ''
  return multipleList ? JSON.stringify(names) : names.join('، ')
}

/**
 * §8.2: an assignment made only of external contacts needs an internal
 * follower from the project. Returns the engine's Arabic refusal, or null.
 */
export function validateChoices(choices: readonly Choice[]): string | null {
  if (choices.length > 0 && choices.every((c) => c.kind === 'external')) return ERROR_MESSAGES.external_requires_follower
  return null
}

/**
 * Names chosen that more than one option carries: the server cannot tell
 * which one is meant (`ambiguous_assignee`).
 */
export function ambiguousNames(choices: readonly Choice[], options: AssigneeOptionsResponse): string[] {
  const all = [...options.projectPeople.map((p) => p.name), ...options.accountPeople.map((p) => p.name), ...options.externals.map((e) => e.name)]
  const out: string[] = []
  for (const c of choices) {
    const name = choiceName(c)
    if (all.filter((n) => sameName(n, name)).length > 1 && !out.includes(name)) out.push(name)
  }
  return out
}

export interface OptionSections {
  project: BcPerson[]
  account: BcPerson[]
  externals: ExternalContact[]
}

/** The options whose name (or e-mail, organisation) contains `query`, by section (§8.2 order). */
export function filterOptions(options: AssigneeOptionsResponse, query: string): OptionSections {
  const q = normalizeName(query)
  const hit = (...texts: Array<string | null>) => q === '' || texts.some((t) => t !== null && normalizeName(t).includes(q))
  return {
    project: options.projectPeople.filter((p) => hit(p.name, p.email)),
    account: options.accountPeople.filter((p) => hit(p.name, p.email)),
    externals: options.externals.filter((e) => hit(e.name, e.organization, e.email)),
  }
}
