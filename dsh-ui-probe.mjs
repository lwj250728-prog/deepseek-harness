#!/usr/bin/env node
/**
 * dsh-ui-probe — runtime probe of the live Web GUI through a real browser.
 *
 * The gap this closes: slot hosts and client plugins can only be checked from
 * the outside by *asking the browser*. Status evidence ("manifest lists the
 * plugin", "the RPC returns 200") cannot distinguish "panel renders" from
 * "panel renders off-screen / empty / behind the chat column". This probe
 * drives headless Chromium over CDP, boots the real URL, clicks the panel
 * trigger, and reports what the DOM actually contains plus the computed
 * geometry/style of the panel — effect evidence, not status evidence.
 *
 * Usage:
 *   node dsh-ui-probe.mjs --url http://127.0.0.1:3080 \
 *     --click '[aria-label="目标轨迹"]' --panel '[aria-label="目标轨迹"][class*=panel]'
 * Options:
 *   --url      page to open (default http://127.0.0.1:3080)
 *   --click    CSS selector to click after boot (optional, repeatable)
 *   --panel    CSS selector of the element whose geometry/style to report
 *   --wait-boot ms to wait for boot before probing (default 8000)
 *   --wait-after ms to wait after the last click (default 4000)
 *   --body-chars max body text chars to include (default 1200)
 *   --json     print the full report as JSON only (no human summary)
 *   --no-record skip appending the run to the probe ledger
 *
 * Every run appends one compact line to `$DSH_COG_DIR/ui-probe.jsonl`
 * (default ~/.dsh/cognitive-pipeline/ui-probe.jsonl, ts with +08:00): a probe
 * whose result is only printed leaves no evidence behind, and the mechanism
 * inventory requires declared records to exist.
 * Exit codes: 0 probe completed, 3 launch/connect failure.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}
const argsAll = name => process.argv.flatMap((a, i) => a === `--${name}` && process.argv[i + 1] !== undefined ? [process.argv[i + 1]] : [])

const URL_ = argOf('url', 'http://127.0.0.1:3080')
const CLICKS = argsAll('click')
const PANEL = argOf('panel', '')
const WAIT_BOOT = Number(argOf('wait-boot', '8000'))
const WAIT_AFTER = Number(argOf('wait-after', '4000'))
const BODY_CHARS = Number(argOf('body-chars', '1200'))
const JSON_ONLY = process.argv.includes('--json')
const PORT = Number(argOf('port', String(9300 + Math.floor(Math.random() * 200))))

const CHROME = process.env.DSH_CHROME
  ?? '/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome'
const profile = mkdtempSync(join(tmpdir(), 'dsh-ui-probe-'))

const sleep = ms => new Promise(r => setTimeout(r, ms))

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
  '--hide-scrollbars', '--window-size=1440,900', 'about:blank',
// stdout must be 'ignore': a piped-but-unread stdout lets chromium block on a
// full pipe buffer before it ever opens the DevTools port (observed as a
// silent launch failure with empty stderr).
], { stdio: ['ignore', 'ignore', 'pipe'] })
let chromeErr = ''
chrome.stderr.on('data', d => { chromeErr += String(d) })

let wsUrl
for (let i = 0; i < 60; i += 1) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) })
    if (res.ok) { wsUrl = (await res.json()).webSocketDebuggerUrl; break }
  } catch { /* not up yet */ }
  await sleep(250)
}
if (!wsUrl) {
  console.error(`launch failed: no CDP endpoint. stderr tail:\n${chromeErr.slice(-800)}`)
  chrome.kill('SIGKILL'); rmSync(profile, { recursive: true, force: true })
  process.exit(3)
}

const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = e => rej(new Error(`ws: ${e.message ?? e}`)) })

let seq = 0
const pending = new Map()
const consoleLog = []
const netFailures = []
const responses = []
const requestUrls = new Map()
const requests = []
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data)
  if (msg.id !== undefined) { pending.get(msg.id)?.(msg); pending.delete(msg.id); return }
  const m = msg.method
  if (m === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
    consoleLog.push({ type: msg.params.type, text: msg.params.args.map(a => a.value ?? a.description ?? a.type).join(' ').slice(0, 400) })
  } else if (m === 'Log.entryAdded') {
    consoleLog.push({ type: msg.params.entry.level, text: `${msg.params.entry.source}: ${msg.params.entry.text}`.slice(0, 400) })
  } else if (m === 'Network.requestWillBeSent') {
    requestUrls.set(msg.params.requestId, msg.params.request.url)
    requests.push({
      at: Date.now(), url: msg.params.request.url.slice(0, 160), method: msg.params.request.method,
      postData: typeof msg.params.request.postData === 'string' ? msg.params.request.postData.slice(0, 200) : undefined,
    })
  } else if (m === 'Network.responseReceived' && msg.params.response.url.startsWith(URL_)) {
    responses.push({ url: msg.params.response.url.slice(0, 160), status: msg.params.response.status, type: msg.params.type })
  } else if (m === 'Network.loadingFailed') {
    netFailures.push({ url: (requestUrls.get(msg.params.requestId) ?? msg.params.requestId).slice(0, 160), error: msg.params.errorText, canceled: msg.params.canceled === true })
  } else if (m === 'Network.responseReceived' && msg.params.response.status >= 400) {
    netFailures.push({ url: msg.params.response.url.slice(0, 200), status: msg.params.response.status })
  }
}
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++seq
  pending.set(id, msg => msg.error ? rej(new Error(`${method}: ${msg.error.message}`)) : res(msg.result))
  ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }))
})

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Page.enable', {}, sessionId)
await send('Runtime.enable', {}, sessionId)
await send('Log.enable', {}, sessionId)
await send('Network.enable', {}, sessionId)

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
  if (r.exceptionDetails) throw new Error(`evaluate threw: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`)
  return r.result.value
}

const loaded = new Promise(res => {
  const prev = ws.onmessage
  ws.onmessage = ev => {
    prev(ev)
    if (JSON.parse(ev.data).method === 'Page.loadEventFired') res()
  }
})
await send('Page.navigate', { url: URL_ }, sessionId)
await Promise.race([loaded, sleep(30_000)])
await sleep(WAIT_BOOT)

const bootState = await evaluate(`(() => {
  const t = document.querySelector('textarea, [contenteditable=true]')
  return {
    title: document.title,
    hasBoot: typeof window.__DSH_BOOT__ === 'object' && window.__DSH_BOOT__ !== null,
    sidebarPresent: !!document.querySelector('aside, [class*=sidebar]'),
    composerPresent: !!t,
    triggerMatches: ${JSON.stringify(CLICKS)}.map(sel => { try { return document.querySelectorAll(sel).length } catch (e) { return 'bad-selector' } }),
  }
})()`)

const clickStartedAt = Date.now()
for (const sel of CLICKS) {
  await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el) el.click(); return !!el })()`)
  await sleep(WAIT_AFTER)
}

const panelReport = PANEL === '' ? null : await evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(PANEL)})
  if (!el) return { found: false }
  const r = el.getBoundingClientRect()
  const cs = getComputedStyle(el)
  return {
    found: true,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    inViewport: r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight,
    style: { position: cs.position, display: cs.display, visibility: cs.visibility, opacity: cs.opacity, zIndex: cs.zIndex, overflow: cs.overflow, left: cs.left, top: cs.top, maxHeight: cs.maxHeight },
    textLen: (el.innerText ?? '').length,
    text: (el.innerText ?? '').slice(0, 800),
    childCount: el.querySelectorAll('*').length,
    topElementAtCenter: (() => {
      const hit = document.elementFromPoint(Math.min(innerWidth - 2, Math.max(1, r.x + r.width / 2)), Math.min(innerHeight - 2, Math.max(1, r.y + Math.min(r.height / 2, 200))))
      return hit === null ? null : (el.contains(hit) || hit.contains(el) ? 'panel' : (hit.className || hit.tagName).toString().slice(0, 80))
    })(),
  }
})()`)

const body = await evaluate(`(document.body.innerText ?? '').slice(0, ${BODY_CHARS})`)
// Requests issued after the boot window: the click-driven traffic is what the
// panel's own fetch shows up as.
const clickRequests = requests.filter(r => r.at >= clickStartedAt)

const report = {
  url: URL_, clicks: CLICKS, bootState, panel: panelReport, bodyText: body,
  clickRequests: clickRequests.slice(-20), allRequests: requests.map(r => `${r.method} ${r.url}`),
  responses: responses.map(r => `${r.status} ${r.url}`), console: consoleLog.slice(-25), netFailures: netFailures.slice(-15),
}

if (JSON_ONLY) console.log(JSON.stringify(report, null, 2))
else {
  console.log(`# UI probe ${URL_}`)
  console.log(`boot: __DSH_BOOT__=${bootState.hasBoot} sidebar=${bootState.sidebarPresent} composer=${bootState.composerPresent} title=${JSON.stringify(bootState.title)}`)
  console.log(`trigger matches per selector: ${JSON.stringify(bootState.triggerMatches)}`)
  console.log(`body text (${body.length} chars):\n${body}`)
  if (panelReport) console.log(`panel: ${JSON.stringify(panelReport, null, 2)}`)
  const apiResponses = responses.filter(r => r.url.includes('/api/'))
  if (apiResponses.length) console.log(`api responses:\n${apiResponses.map(r => `  ${r.status} ${r.url}`).join('\n')}`)
  if (clickRequests.length) console.log(`requests after click (${clickRequests.length}):\n${clickRequests.slice(-10).map(r => `  ${r.method} ${r.url}${r.postData === undefined ? '' : '  body=' + r.postData}`).join('\n')}`)
  if (consoleLog.length) console.log(`console (${consoleLog.length}, tail):\n${consoleLog.slice(-12).map(l => `  [${l.type}] ${l.text}`).join('\n')}`)
  if (netFailures.length) console.log(`net failures:\n${netFailures.slice(-10).map(f => `  ${JSON.stringify(f)}`).join('\n')}`)
}

if (!process.argv.includes('--no-record')) {
  const dir = process.env.DSH_COG_DIR ?? '/home/ubuntu/.dsh/cognitive-pipeline'
  const ts = new Date(Date.now() + 8 * 3600_000).toISOString().replace('Z', '+08:00')
  const line = JSON.stringify({
    ts, origin: process.env.DSH_RUN_ORIGIN ?? 'agent', url: URL_, clicks: CLICKS,
    boot: bootState.hasBoot, sidebar: bootState.sidebarPresent,
    panelFound: panelReport?.found ?? null, panelInViewport: panelReport?.inViewport ?? null,
    panelRect: panelReport?.rect ?? null, panelTextLen: panelReport?.textLen ?? null,
    panelTextHead: panelReport === null || panelReport.found !== true ? null : (panelReport.text ?? '').slice(0, 200),
    clickRequests: clickRequests.map(r => `${r.method} ${r.url}`),
    responses: responses.map(r => `${r.status} ${r.url}`),
    cancelledRequests: netFailures.filter(f => f.canceled === true).map(f => f.url),
    consoleErrors: consoleLog.filter(l => l.type === 'error').slice(-5),
  })
  try { appendFileSync(`${dir}/ui-probe.jsonl`, `${line}\n`) } catch (error) { console.error(`probe record not written: ${error.message}`) }
}

ws.close(); chrome.kill('SIGKILL'); rmSync(profile, { recursive: true, force: true })
process.exit(0)
