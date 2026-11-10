// Types for test/known-upstream.mjs (used by test/known-upstream.test.ts).
export interface Check { name: string; ok: boolean; knownUpstream?: string; detail: Record<string, unknown> & { [k: string]: any } } // eslint-disable-line @typescript-eslint/no-explicit-any
export const CHECK_EDIT: string
export const CHECK_CONTROL_TYPING: string
export const CHECK_LIVE_TYPING: string
export const CONTROL_TYPED: string
export const FIREFOX_ARABIC_INPUT: string
export const FIREFOX_ARABIC_INPUT_LIVE: string
export function firefoxSyntheticArabic(typed: string): string
export function applyKnownUpstream(checks: Check[], browser: string): void
