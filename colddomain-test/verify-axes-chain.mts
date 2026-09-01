/**
 * Full-chain verification: extract discriminant axes on REAL data via the REAL
 * LLM route (deepseek-v4-flash), exercising the complete pipeline — service
 * method → proposeDiscriminantAxes (template 10) → store persistence.
 *
 * 验证链路：CognitivePipelineService.extractDiscriminantAxes()
 *   → 读真实簇（clusters.json + experiences.jsonl）
 *   → 真实 LLM（deepseek-v4-flash）提炼判别轴
 *   → 持久化 discriminant_axes.json
 *
 * 用法：pnpm tsx colddomain-test/verify-axes-chain.mts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as cognitivePipeline from '../packages/cognition/cognitive-pipeline/src/index.ts'

// 从 data/.credentials.yaml 读 key，注入环境变量（llm-deepseek 无 credentials
// seam 时回退读环境）
const root = process.cwd()
const credsText = readFileSync(join(root, 'data/.credentials.yaml'), 'utf8')
const keyMatch = credsText.match(/^DEEPSEEK_API_KEY:\s*(\S+)/m)
if (!keyMatch) throw new Error('no DEEPSEEK_API_KEY in data/.credentials.yaml')
process.env.DEEPSEEK_API_KEY = keyMatch[1]

const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(LlmRuntime)
await ctx.plugin(AgentRegistry)
await ctx.plugin(ToolRuntime)
await ctx.plugin(LlmDeepSeek, { apiKeyEnv: 'DEEPSEEK_API_KEY' })
// 真实数据目录（宿主使用的同一份）
try {
  await ctx.plugin(cognitivePipeline, {
    root: join(root, 'data/cognitive-pipeline'),
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
  })
} catch (error) {
  console.error('cognitive-pipeline 插件挂载失败:', error)
  process.exit(1)
}
const service = (ctx as unknown as { cognitivePipeline?: any }).cognitivePipeline
if (service === undefined) {
  console.error('ctx.cognitivePipeline 仍为 undefined——服务未挂载')
  process.exit(1)
}

const clusters = service.store.clustersSnapshot()
console.log(`现有簇: ${clusters.length} 个`)
for (const c of clusters) {
  const members = c.supportingEvidenceIds.length
  console.log(`  簇 ${c.clusterId} [${c.name.slice(0, 20)}…]: evidence ${members} 条 ${members >= 8 ? '(≥8 会走轴提炼)' : '(跳过)'}`)
}

console.log('\n调用 extractDiscriminantAxes（真实 LLM）...')
const result = await service.extractDiscriminantAxes()
console.log(`结果: clustersExamined=${result.clustersExamined}, axesCount=${result.axesCount}`)

const axes = service.discriminantAxes()
console.log(`\n持久化轴数: ${axes.length}`)
for (const axis of axes) {
  console.log(`  簇${axis.clusterId} [${axis.dimension}] ${axis.axisName}: ${axis.terms.join(' / ')}`)
}

// 确认落盘
const diskPath = join(root, 'data/cognitive-pipeline/discriminant_axes.json')
const onDisk = readFileSync(diskPath, 'utf8')
console.log(`\ndiscriminant_axes.json 已落盘: ${onDisk.length} 字节`)
await ctx.fiber?.dispose?.()
