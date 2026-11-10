// The wrapped cell's text laid out by the browser itself in an RTL paragraph
// of the same width and font: ground truth for line breaks and word order.
// Usage: node wrap-reference.mjs  (writes results/wrap-browser-rtl-2x.png)
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')
const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 400, height: 200 }, deviceScaleFactor: 2 })
const text = 'نص طويل يلتف على أكثر من سطر داخل الخلية، فيه كلمة Basecamp ورقم القضية 2291/ت/1447 لاختبار الترتيب'
await p.setContent(`<html><body style="margin:8px">
<style>@font-face{font-family:T;src:url(https://cdn.jsdelivr.net/gh/engdawood/thmanyah-font-web@4266a9d/fonts/thmanyah-sans/woff2/thmanyah-sans-Regular.woff2)}</style>
<div dir="rtl" style="font:11pt T;width:256px;border:1px solid #999;padding:2px;line-height:1.3">${text}</div></body></html>`)
await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(1200)
await p.screenshot({ path: new URL('./results/wrap-browser-rtl-2x.png', import.meta.url).pathname, clip: { x: 0, y: 0, width: 280, height: 90 } })
await b.close()
