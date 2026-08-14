/**
 * Loader smoke: the plugin must boot through the real Cordis Loader when
 * referenced by package name from a `cordis.yml`, exactly as the `web` profile
 * patch mounts it (`name: '@deepseek-ai/dsh-cognitive-pipeline'`). This guards
 * the Loader wiring (name/inject/Config) that unit tests mount directly.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'

/**
 * The mini cordis.yml lives under the package so Node's module resolution
 * walks up to the repository `node_modules` and finds every
 * `@deepseek-ai/dsh-*` package — the same resolution the `web` profile uses.
 */
const SMOKE_DIR = join(fileURLToPath(new URL('..', import.meta.url)), '.smoke')

/** A mini cordis.yml mounting the pipeline exactly like the web profile patch. */
function composeConfig(root: string): string {
  return [
    '- id: llm',
    "  name: '@deepseek-ai/dsh-llm'",
    '',
    '- id: system-prompt',
    "  name: '@deepseek-ai/dsh-system-prompt'",
    '',
    '- id: tools',
    "  name: '@deepseek-ai/dsh-tools'",
    '',
    '- id: agents',
    "  name: '@deepseek-ai/dsh-agent'",
    '',
    '- id: cognitive-pipeline',
    "  name: '@deepseek-ai/dsh-cognitive-pipeline'",
    '  config:',
    `    root: ${JSON.stringify(root)}`,
    '',
  ].join('\n')
}

describe('cognitive-pipeline Loader wiring', () => {
  it('loads by package name, registers tools and the taxonomy section, and disposes cleanly', async () => {
    mkdirSync(SMOKE_DIR, { recursive: true })
    const dir = mkdtempSync(join(SMOKE_DIR, 'cordis-'))
    try {
      const configPath = join(dir, 'cordis.yml')
      writeFileSync(configPath, composeConfig(join(dir, 'store')), 'utf8')

      const ctx = new Context()
      await ctx.plugin(Loader)
      ctx.loader.builtins.include = Include
      await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
      await ctx.loader.await()
      try {
        for (const name of ['remember_experience', 'predict_outcome', 'report_outcome', 'rebuild_taxonomy', 'inspect_memory']) {
          expect(ctx.tools.get(name)?.name).toBe(name)
        }
        expect(ctx.cognitivePipeline).toBeDefined()
        const assembled = await ctx.systemPrompt.assemble()
        const section = assembled.sections.find(item => item.name === 'cognition:taxonomy')
        expect(section?.text).toContain('冷启动')
        // A prediction through the loaded service persists to the configured root.
        const result = await ctx.cognitivePipeline.predict({ situation: '冒烟', action: '验证加载' })
        expect(result.isNovel).toBe(true)
        const tools = ctx.tools
        await ctx.fiber.dispose()
        expect(tools.get('predict_outcome')).toBeUndefined()
      } finally {
        rmSync(SMOKE_DIR, { recursive: true, force: true })
      }
    } finally {
      rmSync(SMOKE_DIR, { recursive: true, force: true })
    }
  })
})
