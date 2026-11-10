// Known upstream defects of the interaction suite (test/rtl-interactions.mjs),
// matched strictly against evidence. A check is recorded as `knownUpstream`
// (XFAIL) instead of failing the run only when every condition below holds;
// anything else stays a failure. A fix upstream shows up as the checks passing.
// The rules have unit tests of their own (test/known-upstream.test.ts).

/** Check names the rules look at (exact). */
export const CHECK_EDIT = 'double-click opens the editor over the cell; typing lands in that cell'
export const CHECK_CONTROL_TYPING = 'control (not the layer): typing Arabic into the editor of the unmirrored grid'
export const CHECK_LIVE_TYPING = 'typing Arabic renders in bidi order live; the stored value is what the editor shows'
/** What the editing check and its control type. */
export const CONTROL_TYPED = 'تجربة RTL 123'

export const FIREFOX_ARABIC_INPUT = 'Univer 1.4.0 editor + Firefox: synthetic Arabic input stored duplicated and reversed, identically without the mirror'
export const FIREFOX_ARABIC_INPUT_LIVE = 'Univer 1.4.0 editor + Firefox: the same synthetic Arabic input defect as the control; rendering matched the browser at every step'

/**
 * The Firefox defect as CI recorded it (phase 0 report §9.8, and the RTL grid
 * run 42826091336): Playwright's synthetic typing of a character that is not
 * on the US keyboard reaches Univer 1.4.0's editor twice, and the caret stays
 * before it; other characters insert and advance. «تجربة RTL 123» becomes
 * « RTL 123ةةببررججتت».
 */
export function firefoxSyntheticArabic(typed) {
  let text = ''
  let caret = 0
  for (const ch of typed) {
    if (/[؀-ۿ]/.test(ch)) text = text.slice(0, caret) + ch + ch + text.slice(caret)
    else {
      text = text.slice(0, caret) + ch + text.slice(caret)
      caret += ch.length
    }
  }
  return text
}

/** Mark the checks that fail only by a known upstream defect (mutates `checks`). */
export function applyKnownUpstream(checks, browser) {
  if (browser !== 'firefox') return
  const find = (name) => checks.find((c) => c.name === name)
  const edit = find(CHECK_EDIT)
  const control = find(CHECK_CONTROL_TYPING)
  const live = find(CHECK_LIVE_TYPING)

  // Rule 1 (phase 0 report §9.8): the mirrored editing check and the control
  // (same keystrokes, unmirrored grid without the layer) fail with the
  // identical stored text, and the editor still sat on its cell.
  const editorOnCell = edit?.detail?.editor && edit.detail.cell && Math.abs(edit.detail.editor.right - edit.detail.cell.right) <= 6
  if (edit && control && !edit.ok && !control.ok && edit.detail.stored === control.detail.stored && editorOnCell) {
    for (const c of [edit, control]) {
      c.ok = true
      c.knownUpstream = FIREFOX_ARABIC_INPUT
    }
  }

  // Rule 2: the live-typing check, only when, in this same run, the control
  // showed exactly this defect (rule 1 matched and its stored text is the
  // defect of what it typed), and the check failed only because the typed text
  // arrived corrupted the same way: at every step the editor showed exactly
  // the defect of what had been typed so far, painted in the browser's own bidi
  // order, and the stored value is what the editor showed.
  if (!live || live.ok || !control?.knownUpstream || control.detail.stored !== firefoxSyntheticArabic(CONTROL_TYPED)) return
  const d = live.detail ?? {}
  const steps = Array.isArray(d.steps) ? d.steps : []
  const faithful = steps.length > 0 && steps.every((s) => s.same === true && typeof s.typed === 'string' && s.shown === firefoxSyntheticArabic(s.typed))
  if (faithful && d.typedIntact === false && typeof d.typed === 'string' && d.shown === firefoxSyntheticArabic(d.typed) && d.stored === d.shown && d.shown !== d.typed) {
    live.ok = true
    live.knownUpstream = FIREFOX_ARABIC_INPUT_LIVE
  }
}
