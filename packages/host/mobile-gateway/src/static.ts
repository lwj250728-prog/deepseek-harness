/**
 * Gateway-served static surface: the mobile login page, the PWA app shell
 * (manifest + service worker + icons), and the HTML meta injection the proxy
 * applies to DSH index responses so the UI itself is installable. Assets are
 * real files under `static/` (loaded relative to this module, so both the src
 * and lib layouts resolve them) — admins can restyle the login page in place.
 * @module @deepseek-ai/dsh-mobile-gateway/static
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** HTTP path prefix the gateway owns on its own listener. */
export const PREFIX = '/__mobile'

/** The gateway package root, from either the src or lib layout. */
const STATIC_DIR = fileURLToPath(new URL('../static/', import.meta.url))

/** Read the version once from the shipped manifest (cheap, cached). */
export const GATEWAY_VERSION: string = (() => {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }
    return manifest.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** One static file the gateway serves verbatim. */
export interface StaticFile {
  readonly contentType: string
  readonly bytes: Buffer
}

const cache = new Map<string, StaticFile>()

function loadFile(fileName: string, contentType: string): StaticFile {
  const cached = cache.get(fileName)
  if (cached !== undefined) return cached
  const path = `${STATIC_DIR}${fileName}`
  const fallback = existsSync(path) ? readFileSync(path) : Buffer.alloc(0)
  const file: StaticFile = { contentType, bytes: fallback }
  cache.set(fileName, file)
  return file
}

/** The PWA manifest, served at `${PREFIX}/manifest.webmanifest`.
 * @returns the manifest file.
 */
export function manifestFile(): StaticFile {
  return loadFile('manifest.webmanifest', 'application/manifest+json; charset=utf-8')
}

/** The service worker, served at `${PREFIX}/sw.js`.
 * @returns the service-worker file.
 */
export function serviceWorkerFile(): StaticFile {
  return loadFile('sw.js', 'text/javascript; charset=utf-8')
}

/** App icon at the given size, served at `${PREFIX}/icon-<size>.png`.
 * @param size - the icon size in pixels.
 * @returns the icon file.
 */
export function iconFile(size: 192 | 512): StaticFile {
  return loadFile(`icon-${size}.png`, 'image/png')
}

/**
 * The login page, with the gateway version and whether TLS is active baked in
 * (the page shows the right install guidance for the scheme it is served on).
 * @param version - the gateway version to render.
 * @param secure - whether the gateway is served over TLS.
 * @returns the login page HTML.
 */
export function loginPageHtml(version: string, secure: boolean): string {
  let html: string
  try {
    html = readFileSync(new URL('../static/login.html', import.meta.url), 'utf8')
  } catch {
    html = ''
  }
  return html
    .replaceAll('{{VERSION}}', version)
    .replaceAll('{{SECURE}}', secure ? 'true' : 'false')
}

/**
 * Meta block injected into DSH HTML index responses so the DSH UI itself is
 * installable as a PWA through the gateway. Inserted before `</head>`.
 * A viewport meta is deliberately NOT part of the snippet: the gateway adds
 * one only when the upstream page has none, so an existing viewport is never
 * duplicated.
 * @returns the meta HTML snippet.
 */
export function webMetaSnippet(): string {
  return [
    '<meta name="theme-color" content="#0b0e14" />',
    '<meta name="mobile-web-app-capable" content="yes" />',
    '<meta name="apple-mobile-web-app-capable" content="yes" />',
    '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />',
    `<link rel="manifest" href="${PREFIX}/manifest.webmanifest" />`,
    `<link rel="apple-touch-icon" href="${PREFIX}/icon-192.png" />`,
  ].join('')
}

/** Root existence probe (for tests and diagnostics).
 * @returns true when the static directory exists.
 */
export function staticRootPresent(): boolean {
  return existsSync(STATIC_DIR)
}
