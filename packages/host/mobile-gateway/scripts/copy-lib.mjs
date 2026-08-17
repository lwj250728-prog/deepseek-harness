/**
 * Package build: the canonical `tsc -b` project-reference compile emits JS +
 * declarations into `lib/types/` (the repo's normal layout), and this script
 * mirrors the emitted entry JS up to `lib/` so `main`/`bin` resolve without
 * the tsdown bundling pass. The repo-wide `pnpm build` (tsdown) later
 * re-bundles `lib/types/index.js`/`invariant.js` into `lib/` the same way.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const typesDir = join(root, 'lib', 'types')
const outDir = join(root, 'lib')

if (!existsSync(typesDir)) {
  console.error('mobile-gateway: lib/types missing — run `tsc -b .` first')
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })
let copied = 0
for (const entry of readdirSync(typesDir)) {
  if (!entry.endsWith('.js') && !entry.endsWith('.js.map')) continue
  const from = join(typesDir, entry)
  if (!statSync(from).isFile()) continue
  copyFileSync(from, join(outDir, entry))
  copied += 1
}
console.log(`mobile-gateway: copied ${copied} JS artifact(s) to lib/`)
