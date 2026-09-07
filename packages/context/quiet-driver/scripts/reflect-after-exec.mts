#!/usr/bin/env node
/**
 * v27 P0-2 执行后反思钩子: 每次实质执行(候选孵化/行动帧/长响应帧)后触发。
 * 从"本次执行做了什么/发现什么"提炼两类再生:
 *   1. 新开放问题 → open-questions.jsonl (explorable=true)  —— oq 耗材的再生源
 *   2. 新方向候选 → candidates.jsonl (status=pending)        —— 候选池的持续新源
 * 目标: 打破"oq 用光无再生→02:00 断供"缺陷(exp_154 实证)。
 *
 * 用法: npx tsx packages/context/quiet-driver/scripts/reflect-after-exec.mts <frameOutputPath>
 *   frameOutputPath: 指向一帧的 output 文本(临时文件), 由 quiet-driver 在应答落盘后写入。
 *   无新 oq/候选则不改任何账本(执行有产出≠必有新问题——不强制制造)。
 */
import { readFile, writeFile, appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PIPELINE = join(homedir(), '.dsh/cognitive-pipeline')
const OQ_PATH = join(PIPELINE, 'open-questions.jsonl')
const CAND_PATH = join(PIPELINE, 'candidates.jsonl')

interface OpenQ { id?: string; question?: string; status?: string; explorable?: boolean; goal?: string; openedAt?: string; closedNote?: string }
interface Candidate { kind?: string; id?: string; title?: string; relationToA?: string; rationale?: string; proposedAt?: string; status?: string }

async function readJsonl<T>(p: string): Promise<T[]> {
  try {
    const raw = await readFile(p, 'utf8')
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as T)
  } catch { return [] }
}

/** 从执行产出提炼新开放问题——用文本锚点而非 LLM(轻量, 不引入自评环):
 *  产出中出现"待验证/不确定/未验证/疑点/风险/缺口/该不该/是否"等词, 且对应句确实指向未决, 才提取。 */
function extractOpenQuestions(output: string, now: string): Array<{ question: string; goal: string }> {
  if (!output) return []
  const out: Array<{ question: string; goal: string }> = []
  // 逐句扫: 含未决标记的句子, 截取长度 20-120 的疑问/风险句
  const markers = /(?:待验证|未验证|不确定|待确认|疑点|风险|缺口|该不该|是否应|是否该|没想清|需查证|需确认|存疑|未知|待明确|值得注意|暴露)/
  // FIX-1(2026-09-07 19:1x): "完成→边界"——完成报告型输出(无风险/缺口词)也能提炼,
  // 把"已完成X/落地Y"识别为"X的边界/未覆盖"(完成不是终点是边界的起点)。
  const doneMarkers = /(?:已完成|完成|落地|实现|建立|修复|部署|通过|收口)/
  const sentences = output.split(/[\n。！？]/).map((s) => s.trim()).filter((s) => s.length >= 15 && s.length <= 160)
  const dirMarkers = /(?:下一步|该做|应该|建议|方向|值得做|可以考虑|接下来)/
  for (const s of sentences) {
    if (!markers.test(s) && !doneMarkers.test(s)) continue
    if (dirMarkers.test(s)) continue  // 方向句属候选, 不进 oq(防同一句双入账)
    // 清理前缀("风险: xxx"/"疑点: xxx"/"待验证: xxx" 等标签)
    let q = s.replace(/^(?:我|本帧|系统|风险|疑点|待验证|待确认|缺口|问题|观察|发现|注意|经验|教训|已完成|完成|落地|实现|建立|修复|部署|通过|收口)?(?:的)?[:：]?\s*/, '')
    if (!/[？?]$/.test(q) && !q.includes('?')) q = `${q}?`
    out.push({ question: q, goal: '数字生命·目标孵化机制' })
  }
  return out.slice(0, 3)  // 每帧至多 3 条, 防膨胀
}

/** 从执行产出提炼新方向候选——产出中出现"下一步/该做/应该/建议/方向/新思路/值得做"等指向性词 */
function extractCandidates(output: string, now: string): Array<{ title: string; relationToA: string; rationale: string }> {
  if (!output) return []
  const out: Array<{ title: string; relationToA: string; rationale: string }> = []
  const markers = /(?:下一步|该做|应该|建议|方向|新思路|值得做|可做|可以考虑|接下来)/
  const sentences = output.split(/[\n。！？]/).map((s) => s.trim()).filter((s) => s.length >= 15 && s.length <= 160)
  for (const s of sentences) {
    if (!markers.test(s)) continue
    out.push({
      title: s.replace(/^(?:我|本帧|系统)?(?:的)?/, ''),
      relationToA: 'possible',
      rationale: 'v27 执行后反思自动提炼(候选再生源)',
    })
  }
  return out.slice(0, 2)  // 每帧至多 2 条
}

/** 查重: 与现存 open/pending 语义近似(关键词共现)的跳过——防同问题反复入账。 */
function isDuplicate(existing: string[], title: string): boolean {
  const words = title.split(/[\s,，。:：]/).filter((w) => w.length >= 4)
  if (words.length === 0) return false
  return existing.some((e) => {
    let hit = 0
    for (const w of words) { if (e.includes(w)) hit += 1 }
    return hit >= 2
  })
}

async function main(): Promise<void> {
  const outputPath = process.argv[2]
  if (!outputPath) {
    console.error('[reflect-after-exec] 需传入帧 output 临时文件路径')
    process.exit(1)
  }
  let output = ''
  try { output = await readFile(outputPath, 'utf8') } catch { /* 空产出=无再生 */ }
  if (output.trim().length < 20) {
    console.log('[reflect-after-exec] 产出过短, 不提炼(有执行≠必有新问题)')
    return
  }
  // 防线: 过滤 markdown 格式说明文字(测试时脚本注释/示例被误当产出的教训)——
  // 真实执行产出是叙述句, 不含"**加粗** 列表符号"等文档格式。
  if (/\*\*/.test(output) || /^- /.test(output) || /^#/.test(output)) {
    console.log('[reflect-after-exec] 输入含文档格式(加粗/列表/标题), 非真实执行产出, 跳过提炼')
    return
  }
  const now = new Date().toISOString()

  // 1. 提炼新 oq
  const [oqs, cands] = await Promise.all([
    readJsonl<OpenQ>(OQ_PATH),
    readJsonl<Candidate>(CAND_PATH),
  ])
  const existingOqTitles = oqs.map((o) => o.question ?? '')
  const newOqs = extractOpenQuestions(output, now).filter((o) => !isDuplicate(existingOqTitles, o.question))
  for (const o of newOqs) {
    await appendFile(OQ_PATH, JSON.stringify({
      kind: 'open-question', id: `oq-${Date.now()}`, question: o.question,
      status: 'open', explorable: true, goal: o.goal, openedAt: now,
      source: 'reflect-after-exec(v27)',
    }) + '\n', 'utf8')
    console.log(`[reflect-after-exec] +oq ${o.question.slice(0, 60)}`)
  }

  // 2. 提炼新候选
  const existingCandTitles = cands.map((c) => c.title ?? '')
  const newCands = extractCandidates(output, now).filter((c) => !isDuplicate(existingCandTitles, c.title))
  for (const c of newCands) {
    await appendFile(CAND_PATH, JSON.stringify({
      kind: 'goal-candidate', id: `cand-${Date.now()}`, title: c.title,
      relationToA: c.relationToA as Candidate['relationToA'], rationale: c.rationale,
      proposedAt: now, status: 'pending',
    }) + '\n', 'utf8')
    console.log(`[reflect-after-exec] +cand ${c.title.slice(0, 60)}`)
  }
  console.log(`[reflect-after-exec] 完成: +${newOqs.length} oq, +${newCands.length} cand`)
}

main().catch((err: unknown) => { console.error('[reflect-after-exec] failed:', err); process.exit(1) })
