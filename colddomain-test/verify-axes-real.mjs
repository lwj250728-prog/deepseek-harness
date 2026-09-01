#!/usr/bin/env node
/**
 * Real-LLM discriminant-axis verification (设计验证 · §6.1 第2步, e2e).
 *
 * 用真实 DeepSeek API + 真实数据（簇 10，31 条"认知插件开发"过宽簇成员）
 * 验证：proposeDiscriminantAxes 的 prompt（PROPOSE_DISCRIMINANT_AXES_SYSTEM_PROMPT）
 * 能否从过宽簇中提炼出真实的判别轴（如 新手↔资深、冷启动↔增量 等）。
 *
 * 这是对第 2 步核心假设的端到端验证：embedding 聚类分不开的子群体，
 * LLM 定轴能否识别。代码路径本身已由单元测试锁定，此处只验 prompt+真实数据。
 *
 * 用法：node colddomain-test/verify-axes-real.mjs
 * 依赖：data/.credentials.yaml 的 DEEPSEEK_API_KEY
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// 读取真实 key（与 data/.credentials.yaml 相同格式）
const creds = readFileSync(join(root, 'data/.credentials.yaml'), 'utf8')
const keyMatch = creds.match(/^DEEPSEEK_API_KEY:\s*(\S+)/m)
if (!keyMatch) {
  console.error('未找到 DEEPSEEK_API_KEY')
  process.exit(1)
}
const apiKey = keyMatch[1]

// 读取簇 10 的成员（31 条）
const exps = readFileSync(join(root, 'data/cognitive-pipeline/experiences.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(line => JSON.parse(line))
const members = exps.filter(e => e.clusterId === 10)
console.log(`簇 10 成员: ${members.length} 条`)

// 从 prompts.ts 读取 prompt（复制核心，避免 import ts）
const SYSTEM_PROMPT = [
  '你是认知架构的"判别维度分析师"。给定一个语义聚类得到的簇及其成员经验（情境-行动-结果），这些成员表面相似（嵌入相近）但内部可能存在行为上不同的子群体。',
  '【任务】：',
  '1. 找出簇内真正导致策略/行为不同的**判别维度**（轴），例如：用户熟练度（新手↔资深）、环境故障类型、任务阶段、风险等级、时间压力。',
  '2. 每个轴给出两个或更多**极性判别词**（该轴两端/各档的典型词或短语），用于在查询侧区分成员。',
  '3. 只提炼**对行动选择有实际影响**的轴——如果簇内所有成员策略一致、无行为差异，输出空数组（宁缺毋滥）。',
  '【判别词要求】：',
  '- 必须来自成员经验中真实出现的词/短语，禁止编造。',
  '- 每个轴 2-4 个判别词，按区分力排序。',
  '- 判别词是词或短短语（≤8字），不是整句。',
  '【输出JSON格式】：',
  '{',
  '  "axes": [',
  '    {',
  '      "dimension": "situation 或 action",',
  '      "axisName": "判别轴名称，如 用户熟练度",',
  '      "terms": ["新手", "资深"],',
  '      "rationale": "一句话说明为什么这个轴区分行为"',
  '    }',
  '  ]',
  '}',
].join('\n')

const user = `【当前簇】：认知插件开发簇\n\n【簇内成员经验】（${members.length} 条）：\n`
  + members.map(m => `- [${m.expId}] ${m.sar.situation}。${m.sar.action}。${m.sar.outcome}`).join('\n')

console.log('调用 DeepSeek API (deepseek-chat)...')
const response = await fetch('https://api.deepseek.com/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: user },
    ],
    max_tokens: 1500,
  }),
})
if (!response.ok) {
  console.error(`API 失败: ${response.status} ${await response.text()}`)
  process.exit(1)
}
const data = await response.json()
const text = data.choices?.[0]?.message?.content ?? ''
console.log('\n=== 原始输出 ===')
console.log(text.slice(0, 2000))

// 提取 JSON（容忍 markdown 围栏）
const jsonMatch = text.match(/\{[\s\S]*\}/)
if (!jsonMatch) {
  console.error('\n⚠ 未提取到 JSON')
  process.exit(0)
}
try {
  const parsed = JSON.parse(jsonMatch[0])
  console.log('\n=== 解析结果 ===')
  for (const axis of parsed.axes ?? []) {
    console.log(`轴 [${axis.dimension}] ${axis.axisName}: ${(axis.terms ?? []).join(' / ')}`)
    console.log(`  理由: ${axis.rationale}`)
  }
  console.log(`\n轴数: ${(parsed.axes ?? []).length}`)
  // 验证判别词来自真实成员文本
  const allText = members.map(m => `${m.sar.situation}${m.sar.action}${m.sar.outcome}`).join('')
  console.log('\n=== 判别词真实性校验（是否来自成员文本） ===')
  for (const axis of parsed.axes ?? []) {
    for (const term of axis.terms ?? []) {
      const found = allText.includes(term)
      console.log(`  "${term}": ${found ? '✅ 真实出现' : '⚠ 未在成员文本中找到'}`)
    }
  }
} catch (error) {
  console.error(`JSON 解析失败: ${String(error)}`)
}
