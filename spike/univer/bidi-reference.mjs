// Renders the same mixed Arabic/Latin strings with the browser's own bidi
// algorithm, once in an RTL paragraph and once in an LTR one. Comparing a
// Univer cell against both rows shows which base direction Univer applied.
// Usage: node bidi-reference.mjs results
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')
const out = process.argv[2]
const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 900, height: 300 }, deviceScaleFactor: 2 })
const strs = ['نشر المقال على LinkedIn', 'متابعة قضية رقم 2291/ت/1447', 'نسخة v2 معتمدة', 'الجلسة 10:30', 'المبلغ 12,400.00 ريال']
const row = (dir) => `<tr><th>${dir}</th>${strs.map(s => `<td dir="${dir}">${s}</td>`).join('')}</tr>`
await p.setContent(`<html><body style="margin:8px">
<style>@font-face{font-family:T;src:url(https://cdn.jsdelivr.net/gh/engdawood/thmanyah-font-web@4266a9d/fonts/thmanyah-sans/woff2/thmanyah-sans-Regular.woff2)}
td,th{font:11pt T;border:1px solid #999;padding:4px 6px;text-align:right}</style>
<table style="border-collapse:collapse">${row('rtl')}${row('ltr')}</table></body></html>`)
await p.evaluate(() => document.fonts.ready)
await p.waitForTimeout(1500)
await p.screenshot({ path: out + '/browser-reference-2x.png', fullPage: false, clip: { x: 0, y: 0, width: 900, height: 80 } })
await b.close()
