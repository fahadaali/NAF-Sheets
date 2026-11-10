// Text normalisation for the mapping wizard (spec §7.3): header synonyms and
// status values are compared after it.
//
// Folded: Arabic diacritics (tashkeel, superscript alef), tatweel, alef forms
// (أ إ آ ٱ → ا, so "تاريخ الانجاز" matches "تاريخ الإنجاز"), Latin case,
// bidi/zero-width controls, punctuation (to spaces) and runs of whitespace.
// Not folded: ة/ه, ى/ي, the definite article. OPEN: OPEN_QUESTIONS.md §10.

const DIACRITICS = /[ً-ٰٟ]/g
const TATWEEL = /ـ/g
const ALEF_FORMS = /[آأإٱ]/g
const CONTROLS = /[​-‏‪-‮⁦-⁩﻿]/g
const PUNCTUATION = /[؟?!:：*.،,؛;()[\]{}"'«»\-_/\\|#]+/g

export function normalizeLabel(text: string): string {
  return text
    .normalize('NFC')
    .replace(CONTROLS, '')
    .replace(DIACRITICS, '')
    .replace(TATWEEL, '')
    .replace(ALEF_FORMS, 'ا')
    .replace(PUNCTUATION, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** Arabic-Indic and Eastern Arabic-Indic digits to Latin; Arabic decimal separator to `.`. */
export function latinDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.')
}
