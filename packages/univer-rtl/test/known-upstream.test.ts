// Unit tests for test/known-upstream.mjs: the strict rules that let the
// interaction suite record a known upstream defect (XFAIL) instead of failing.
// The defect model must reproduce, character for character, what CI recorded
// in Firefox; every condition of a rule must be required, so anything else
// stays a failure.
import { describe, expect, it } from 'vitest'
import {
  applyKnownUpstream, CHECK_CONTROL_TYPING, CHECK_EDIT, CHECK_LIVE_TYPING, CONTROL_TYPED, FIREFOX_ARABIC_INPUT, FIREFOX_ARABIC_INPUT_LIVE, firefoxSyntheticArabic,
} from './known-upstream.mjs'
import type { Check } from './known-upstream.mjs'

// Recorded by CI in Firefox (RTL grid run 42826091336, artifact rtl-grid-firefox).
const CI_CONTROL_STORED = ' RTL 123ةةببررججتت'
const LIVE_PIECES = ['نص ', 'تجريبي ', 'LinkedIn ', '2026 ', 'نهاية']
const CI_LIVE_STEPS = [' صصنن', '  ييببييررججتتصصنن', '  LinkedIn ييببييررججتتصصنن', '  LinkedIn 2026 ييببييررججتتصصنن', '  LinkedIn 2026 ةةييااههننييببييررججتتصصنن']

describe('firefoxSyntheticArabic (the defect model)', () => {
  it('reproduces what CI stored for the control', () => {
    expect(firefoxSyntheticArabic(CONTROL_TYPED)).toBe(CI_CONTROL_STORED)
  })

  it('reproduces every step CI recorded for live typing', () => {
    let typed = ''
    LIVE_PIECES.forEach((piece, i) => {
      typed += piece
      expect(firefoxSyntheticArabic(typed)).toBe(CI_LIVE_STEPS[i])
    })
  })

  it('leaves text without Arabic as typed', () => {
    expect(firefoxSyntheticArabic('Basecamp API v2')).toBe('Basecamp API v2')
  })
})

// Checks as the suite records them in Firefox with the defect present.
const firefoxRun = (): Check[] => {
  let typed = ''
  const steps = LIVE_PIECES.map((piece) => {
    typed += piece
    return { typed, shown: firefoxSyntheticArabic(typed), same: true }
  })
  const shown = steps[steps.length - 1]!.shown
  return [
    { name: CHECK_EDIT, ok: false, detail: { stored: CI_CONTROL_STORED, editor: { right: 244 }, cell: { right: 244 } } },
    { name: CHECK_LIVE_TYPING, ok: false, detail: { typed, shown, stored: shown, typedIntact: false, steps } },
    { name: CHECK_CONTROL_TYPING, ok: false, detail: { stored: CI_CONTROL_STORED } },
  ]
}
const byName = (checks: Check[], name: string) => checks.find((c) => c.name === name)!

describe('applyKnownUpstream', () => {
  it('records the three checks as the known Firefox defect when every condition holds', () => {
    const checks = firefoxRun()
    applyKnownUpstream(checks, 'firefox')
    expect(byName(checks, CHECK_EDIT)).toMatchObject({ ok: true, knownUpstream: FIREFOX_ARABIC_INPUT })
    expect(byName(checks, CHECK_CONTROL_TYPING)).toMatchObject({ ok: true, knownUpstream: FIREFOX_ARABIC_INPUT })
    expect(byName(checks, CHECK_LIVE_TYPING)).toMatchObject({ ok: true, knownUpstream: FIREFOX_ARABIC_INPUT_LIVE })
  })

  it('never applies outside Firefox', () => {
    for (const browser of ['chromium', 'webkit']) {
      const checks = firefoxRun()
      applyKnownUpstream(checks, browser)
      expect(checks.every((c) => !c.ok && c.knownUpstream === undefined)).toBe(true)
    }
  })

  describe('rule 1 (editing check and its control)', () => {
    it('stays a failure when the mirrored result differs from the control', () => {
      const checks = firefoxRun()
      byName(checks, CHECK_EDIT).detail.stored = 'something else'
      applyKnownUpstream(checks, 'firefox')
      expect(byName(checks, CHECK_EDIT).ok).toBe(false)
      expect(byName(checks, CHECK_CONTROL_TYPING).ok).toBe(false)
    })
    it('stays a failure when the editor left its cell', () => {
      const checks = firefoxRun()
      byName(checks, CHECK_EDIT).detail.editor = { right: 200 }
      applyKnownUpstream(checks, 'firefox')
      expect(byName(checks, CHECK_EDIT).ok).toBe(false)
    })
    it('is not needed when the editing check passes', () => {
      const checks = firefoxRun()
      byName(checks, CHECK_EDIT).ok = true
      applyKnownUpstream(checks, 'firefox')
      expect(byName(checks, CHECK_EDIT).knownUpstream).toBeUndefined()
      expect(byName(checks, CHECK_CONTROL_TYPING).ok).toBe(false)
    })
  })

  describe('rule 2 (live typing) needs every condition', () => {
    const live = (mutate: (checks: Check[]) => void) => {
      const checks = firefoxRun()
      mutate(checks)
      applyKnownUpstream(checks, 'firefox')
      return byName(checks, CHECK_LIVE_TYPING)
    }
    it('the control must show the defect in the same run', () => {
      expect(live((c) => { byName(c, CHECK_CONTROL_TYPING).ok = true }).ok).toBe(false)
      expect(live((c) => { byName(c, CHECK_EDIT).detail.stored = 'differs'; byName(c, CHECK_CONTROL_TYPING).detail.stored = 'differs' }).ok).toBe(false)
    })
    it('every step must be painted in the browser\'s bidi order', () => {
      expect(live((c) => { (byName(c, CHECK_LIVE_TYPING).detail.steps as Array<{ same: boolean }>)[2]!.same = false }).ok).toBe(false)
    })
    it('the stored value must be what the editor showed', () => {
      expect(live((c) => { byName(c, CHECK_LIVE_TYPING).detail.stored = 'x' }).ok).toBe(false)
    })
    it('the corruption must be exactly the defect, at every step', () => {
      expect(live((c) => { const d = byName(c, CHECK_LIVE_TYPING).detail; d.shown = d.stored = [...d.shown].reverse().join('') }).ok).toBe(false)
      expect(live((c) => { (byName(c, CHECK_LIVE_TYPING).detail.steps as Array<{ shown: string }>)[1]!.shown = 'نص تجريبي ' }).ok).toBe(false)
    })
    it('a failure with the typed text intact is a real failure', () => {
      expect(live((c) => {
        const d = byName(c, CHECK_LIVE_TYPING).detail
        d.typedIntact = true
        d.shown = d.stored = d.typed
      }).ok).toBe(false)
    })
  })
})
