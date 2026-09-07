#!/usr/bin/env node
/**
 * P-A2 方向自省（v26 §4.2）：每完成一个 active 目标后触发。
 * 读 north-star.jsonl 的 directionNote + 当前目标池状态，
 * 产出 2-5 个与 A 有关联的新候选（relationToA: direct/possible/unknown/probe），
 * 追加到 candidates.jsonl，并更新 north-star reflectCount/history。
 * 触发点：v24 目标回写成功 或 手动执行（验证用）。
 *
 * 用法: npx tsx packages/context/quiet-driver/scripts/north-star-reflect.mts
 *       或 node scripts 编译版（部署路径同插件 lib）
 */
import { readFile, writeFile, appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PIPELINE = join(homedir(), '.dsh/cognitive-pipeline')
const NS_PATH = join(PIPELINE, 'north-star.jsonl')
const CAND_PATH = join(PIPELINE, 'candidates.jsonl')
const GOALS_PATH = join(PIPELINE, 'dormant-goals.jsonl')

interface NorthStar { kind?: string; id?: string; title?: string; directionNote?: string; reflectCount?: number; history?: Array<Record<string, unknown>> }
interface Candidate { kind: string; id: string; title: string; relationToA: 'direct'|'possible'|'unknown'|'probe'; rationale: string; proposedAt: string; status: string }
interface Goal { id?: string; title?: string; status?: string; nextAction?: string; notes?: string[] }

async function readJsonl<T>(p: string): Promise<T[]> {
  try {
    const raw = await readFile(p, 'utf8')
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as T)
  } catch { return [] }
}

/** 从目标池最新状态生成候选（阶梯就近: 看当前 active 目标与挂账, 问 A 的哪面够得着）。 */
async function generateCandidates(goals: Goal[], ns: NorthStar, now: string): Promise<Candidate[]> {
  const cands: Candidate[] = []
  const activeTitles = goals.filter((g) => g.status === 'active').map((g) => g.title ?? '')
  const waiting = goals.filter((g) => (g.nextAction ?? '').startsWith('待用户'))
  const nsNote = ns.directionNote ?? ''

  // 查重: 读候选池现存 pending, 同 (relationToA + 标题模板前缀) 已存在则本次不重复产(去重缺陷修复)
  // 查重(v27 修正): 同 relation+标题模板 若在【最近候选】中已存在(pending 或 近期 completed/closed)
  // 则本次不重复产——防"审视等待项"类模板被执行(变completed)后又被再产的循环。
  let recentCands: Candidate[] = []
  try {
    recentCands = await readJsonl<Candidate>(CAND_PATH)
  } catch { recentCands = [] }
  const recentTail = recentCands.slice(-8)  // 只看最近 8 条(模板近期被消费过=刚审视过)
  const hasRecent = (relation: Candidate['relationToA'], titlePrefix: RegExp): boolean =>
    recentTail.some((c) => c.relationToA === relation && titlePrefix.test(c.title ?? ''))

  // 1. 有 active 目标在等用户 → 提示"把等待项拆成可执行子步或确认是否仍值得等"(probe)
  if (waiting.length > 0) {
    const title = `审视等待项: ${waiting.map((g) => g.title).join('、')} 的 nextAction 停在"待用户"——是否有可自主推进的子步, 或该降级/挂起而非阻塞?`
    if (!hasRecent('probe', /^审视等待项/)) {
      cands.push({
        kind: 'goal-candidate', id: `cand-${Date.now()}-waiting`,
        title,
        relationToA: 'probe', rationale: 'A 要求"自主推进"——等待用户型 nextAction 若长期阻塞且无自主子步, 可能反映目标拆解不当(把需外部输入的整块当一步)', proposedAt: now, status: 'pending',
      })
    }
  }

  // 2. directionNote 若指向未落地的下一阶梯 → direct
  if (/下一阶梯|下一步|待实现|待落地|未实现/.test(nsNote)) {
    const next = nsNote.split(/下一阶梯[=：:]|下一步[=：:]/).pop()?.split(/[;；]/)[0]?.slice(0, 40) ?? nsNote.slice(0, 40)
    if (!hasRecent('direct', /^落地 directionNote/)) {
      cands.push({
        kind: 'goal-candidate', id: `cand-${Date.now()}-nextstep`,
        title: `落地 directionNote 指向的下一阶梯: ${next}`,
        relationToA: 'direct', rationale: `north-star 自身标注的下一阶梯("${next}")是当前最够得着的 direct 候选`, proposedAt: now, status: 'pending',
      })
    }
  }

  // 3. 长期无新产出/无外部反馈的 active 创作目标 → possible(该引入外部信号校准?)
  const stalledCreative = activeTitles.find((t) => /小说|创作|写|连载/.test(t) && waiting.length > 0)
  if (stalledCreative) {
    const title = `为 ${stalledCreative} 建立外部反馈信号(读者数据/平台状态核验)以校准方向——A 的"自我修正"需要外部锚`
    if (!hasRecent('possible', /^为 .*建立外部反馈信号/)) {
      cands.push({
        kind: 'goal-candidate', id: `cand-${Date.now()}-feedback`,
        title,
        relationToA: 'possible', rationale: '无人验收时创作易自嗨; 外部数据是 A"自我修正"的必要输入', proposedAt: now, status: 'pending',
      })
    }
  }

  return cands.slice(0, 5)  // 每次最多 5 个
}

async function main(): Promise<string> {
  const nsList = await readJsonl<NorthStar>(NS_PATH)
  const ns = nsList.find((n) => n.kind === 'north-star') ?? { kind: 'north-star', id: 'north-star-a', title: '', reflectCount: 0, history: [] }
  const goals = await readJsonl<Goal>(GOALS_PATH)
  const now = new Date().toISOString()
  const cands = await generateCandidates(goals, ns, now)

  let summary: string
  if (cands.length === 0) {
    summary = 'north-star-reflect: 无新候选(目标池无等待项/方向无未落地阶梯)——跳过前瞻'
  } else {
    for (const c of cands) {
      await appendFile(CAND_PATH, JSON.stringify(c) + '\n', 'utf8')
    }
    summary = `产出 ${cands.length} 候选 -> ${cands.map((c) => c.id).join(', ')}`
  }
  // 更新 north-star
  const updated: NorthStar = {
    ...ns,
    reflectCount: (ns.reflectCount ?? 0) + 1,
    history: [...(ns.history ?? []), { at: now, 拆出目标ids: cands.map((c) => c.id), 回望结论: summary }],
  }
  const others = nsList.filter((n) => n !== ns)
  await writeFile(NS_PATH, [...others, updated].map((n) => JSON.stringify(n)).join('\n') + '\n', 'utf8')

  // ── P-A3 回望修正: 检查已 completed 候选是否真推进 A(artifact 存在? directionNote 是否因它演进?) ──
  try {
    const completed = (await readJsonl<Candidate>(CAND_PATH)).filter((c) => c.status === 'completed' && c.artifact)
    let advanced = 0, unverified = 0
    for (const c of completed) {
      const art = c.artifact as string | undefined
      if (!art) continue
      // artifact 必须真实存在(文件锚——评审 L1/L2 精神, 不认自报)
      const artPath = join(PIPELINE, art)
      try { await readFile(artPath, 'utf8'); advanced += 1 }
      catch { unverified += 1 }  // artifact 缺失 = 疑似未落地
    }
    if (completed.length > 0) {
      const retro = { at: now, 回望目标: `P-A3 回望: ${completed.length} 个 completed 候选`, 回望结论: `artifact 存在 ${advanced}/${completed.length}, 疑似未落地 ${unverified}` }
      const updated2: NorthStar = { ...updated, reflectCount: (updated.reflectCount ?? 0) + 1, history: [...(updated.history ?? []), retro] }
      await writeFile(NS_PATH, [...others, updated2].map((n) => JSON.stringify(n)).join('\n') + '\n', 'utf8')
    }
  } catch (retroErr: unknown) {
    console.error('north-star-reflect retro failed:', retroErr)
  }
  return `north-star-reflect: 产出 ${cands.length} 候选 -> ${cands.map((c) => c.id).join(', ')}`
}

main().then((r) => { console.log(r); process.exit(0) }).catch((e) => { console.error('north-star-reflect failed:', e); process.exit(1) })
