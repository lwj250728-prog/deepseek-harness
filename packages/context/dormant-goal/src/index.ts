/**
 * @deepseek-ai/dsh-dormant-goal — dormant-goal sentinel (目标孵化·哨兵).
 *
 * The dormant-goal pool holds long-term goals that are NOT being executed
 * round by round. At every agent pre-step this plugin:
 *   1. extracts the incoming situation (same helper as cognitive-inject);
 *   2. cheaply scans the pool by each goal's single `repVector` (cosine);
 *   3. on a hit above the coarse threshold, refines kernel/focus layers;
 *   4. injects a 【目标孵化提醒】 block into the step's messages so the goal
 *      can be advanced by the intersecting situation (incubation), instead of
 *      being polled by a loop.
 *
 * The sentinel only triggers — it never executes the goal. Cooldown and the
 * per-layer thresholds keep incubation a sparse event, not an alarm. Adopted
 * triggers are counted back into the pool file (triggerCount) for the
 * trigger→adopt→advance statistics that separate real incubation from noise.
 *
 * @module @deepseek-ai/dsh-dormant-goal
 */

import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { cosine, situationVector } from '@deepseek-ai/dsh-cognitive-pipeline'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

/** Stable Cordis plugin name. */
const require = createRequire(import.meta.url)

export const name = 'dormant-goal-sentinel'
/** Services whose presence this plugin relies on (pre-step events exist once agents run). */
export const inject = ['agents']

/** Plugin config. */
export interface Config {
  enabled: boolean
  /** Pool file path; `~` expands to the home directory. */
  poolPath: string
  /** Coarse rep-vector threshold that opens refinement (embedding space). */
  repThreshold: number
  /** Per-layer refinement thresholds. */
  kernelThreshold: number
  focusThreshold: number
  /** Same-session cooldown before the same goal may trigger again (ms). */
  cooldownMs: number
  /** Minimum situation text length before scanning (chars). */
  minChars: number
  /** Failure-sink: repeat failures in one domain auto-sink a dormant goal. */
  failSink: boolean
  /** Same-domain failure count that triggers the sink. */
  failThreshold: number
  /** Debug: append every tools/result observation to failure-domains.debug.jsonl. */
  debugFail: boolean
  /** Adoption keywords per goal id: when the turn text contains one of these
   * after a trigger, the trigger counts as ADOPTED (trigger→adopt statistics).
   * Empty map disables adoption detection (v1: triggers only). */
  adoptKeywords: Record<string, string[]>
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  poolPath: z.string().default('~/.dsh/cognitive-pipeline/dormant-goals.jsonl'),
  repThreshold: z.number().default(0.5),
  kernelThreshold: z.number().default(0.62),
  focusThreshold: z.number().default(0.55),
  cooldownMs: z.number().default(10 * 60 * 1000),
  minChars: z.number().default(20),
  failSink: z.boolean().default(true),
  failThreshold: z.number().default(3),
  debugFail: z.boolean().default(false),
  adoptKeywords: z.dict(z.array(z.string())).default({}),
})

interface PoolGoal {
  id: string
  title?: string
  kernel?: string
  focus?: string
  repVector?: number[]
  kernelVector?: number[]
  focusVector?: number[]
  triggerThresholds?: { kernel?: number; focus?: number }
}

function expand(path: string): string {
  return path.startsWith('~') ? join(homedir(), path.slice(1)) : path
}

/** Stable tokens of one tool execution: script/file names, URL hosts. */
function domainTokens(name: string, args: unknown): string[] {
  const raw = typeof args === 'object' && args !== null ? JSON.stringify(args) : String(args ?? '')
  const toks = new Set<string>()
  for (const m of raw.matchAll(/([A-Za-z0-9_\u4e00-\u9fa5-]+\.(?:py|md|sh|json|ts|txt|yml))/g)) {
    const t = m[1]
    if (!/^(python3|bash|drafts|index)$/.test(t)) toks.add(t)
  }
  for (const m of raw.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) toks.add(String(m[1]).replace('www.', ''))
  if (toks.size === 0 && name.length > 1) toks.add(name)
  return [...toks].slice(0, 6)
}

interface FailureDomain {
  tokens: string[]
  count: number
  lastAt: number
  sunk: boolean
}

function loadDomains(path: string): FailureDomain[] {
  try {
    const raw = require('node:fs').readFileSync(path, 'utf8')
    return raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as FailureDomain)
  } catch {
    return []
  }
}

/** Persist the failure-domain table best-effort. */
function saveDomains(path: string, domains: FailureDomain[]): void {
  try {
    require('node:fs').writeFileSync(path, domains.map(d => JSON.stringify(d)).join('\n') + '\n')
  } catch {
    /* best-effort */
  }
}


function textOf(message: UserMessage): string {
  for (const block of message.content) {
    if (block.type === 'text') return block.text
  }
  return ''
}

function situationText(messages: readonly UserMessage[]): string {
  return messages.map(textOf).filter(Boolean).slice(-4).join(' ')
}

/**
 * Mount the sentinel: read the pool, scan at every pre-step, inject on hit.
 * @param ctx - plugin context.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const poolPath = expand(config.poolPath)
  let pool: PoolGoal[] = []
  let poolError: string | undefined
  const lastTrigger = new Map<string, number>()
  /** Goals triggered during the current turn per session (adoption candidates). */
  const pending = new Map<string, Set<string>>()
  const failPath = join(dirname(poolPath), 'failure-domains.jsonl')
  const failSink = config.failSink
  const failThreshold = config.failThreshold
  let domains: FailureDomain[] = failSink ? loadDomains(failPath) : []
  const domainKey = (tokens: string[]): string => [...tokens].sort().join('|')
  const findDomain = (tokens: string[]): FailureDomain | undefined =>
    domains.find(d => d.tokens.some(t => tokens.includes(t)))

  // tools/result: count domain failures, decay on success.
  ctx.on('tools/result', (exec: { name: string; arguments: unknown }, result: { isError: boolean; content?: readonly { type?: string; text?: string }[] }) => {
    if (!failSink) return
    // bash-style non-zero exits surface in content, not in isError.
    const text = (result.content ?? []).map(b => b.text ?? '').join(' ')
    const failed = result.isError || /exit code: [1-9]\d*/.test(text) || /Traceback|Error:/.test(text)
    if (config.debugFail) {
      try {
        require('node:fs').appendFileSync(join(dirname(poolPath), 'failure-domains.debug.jsonl'),
          JSON.stringify({ name: exec.name, failed, isError: result.isError, text: text.slice(0, 120), t: Date.now() }) + '\n')
      } catch { /* debug best-effort */ }
    }
    const tokens = domainTokens(exec.name, exec.arguments)
    if (tokens.length === 0) return
    const key = domainKey(tokens)
    const existing = findDomain(tokens)
    if (failed) {
      if (existing) {
        existing.count += 1
        existing.lastAt = Date.now()
      } else {
        domains.push({ tokens, count: 1, lastAt: Date.now(), sunk: false })
      }
    } else if (existing) {
      // A success in the domain means it is not stuck: decay strongly.
      existing.count = Math.max(0, existing.count - 2)
    }
    saveDomains(failPath, domains)
  }, 'dormant-goal failure domains')

  const bump = (goalId: string, adopt: boolean): void => {
    void readFile(poolPath, 'utf8').then(raw => {
      const lines = raw.split('\n').filter(Boolean)
      const out = lines.map(line => {
        const g = JSON.parse(line) as PoolGoal & { triggerCount?: number; adoptedCount?: number }
        if (g.id === goalId) {
          g.triggerCount = (g.triggerCount ?? 0) + 1
          if (adopt) g.adoptedCount = (g.adoptedCount ?? 0) + 1
        }
        return JSON.stringify(g)
      })
      import('node:fs/promises').then(fs => fs.writeFile(poolPath, out.join('\n') + '\n')).catch(() => undefined)
    }).catch(() => undefined)
  }

  const reload = async (): Promise<void> => {
    try {
      const raw = await readFile(poolPath, 'utf8')
      const loaded = raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as PoolGoal)
      // 2026-09-09 10:2x 修复(cl-060): 池里的 rep/kernel/focus 向量是 1024 维(bge-m3 embedding),
      // 而哨兵运行时算的是 384 维哈希袋向量——cosine 长度不等恒返回 0, 于是自 09-04 建池以来
      // triggerCount 一直是 0(机制从未可能触发)。这里在载入时按当前维度自愈: 维度不符就用
      // 目标文本(kernel/focus)重算, 使机制不再依赖池文件里那份历史向量。
      const probe = situationVector('probe')
      let healed = 0
      pool = loaded.map(goal => {
        const mismatch = goal.repVector === undefined
          || goal.repVector.length !== probe.length
          || goal.kernelVector === undefined
          || goal.kernelVector.length !== probe.length
          || goal.focusVector === undefined
          || goal.focusVector.length !== probe.length
        if (!mismatch) return goal
        healed += 1
        return {
          ...goal,
          dim: probe.length,
          repVector: situationVector(`${goal.kernel ?? ''} ${goal.focus ?? ''}`),
          kernelVector: situationVector(goal.kernel ?? goal.title ?? ''),
          focusVector: situationVector(goal.focus ?? goal.title ?? ''),
        }
      })
      if (healed > 0) {
        ctx.logger.warn(`[dormant-goal] ${healed} 个目标向量维度不符(池 ${loaded[0]?.repVector?.length ?? '?'} vs 运行时 ${probe.length}), 已按文本重算`)
      }
      poolError = undefined
    } catch (error) {
      poolError = error instanceof Error ? error.message : String(error)
      pool = []
    }
  }
  void reload()

  ctx.on('agent/pre-step', async ({ agent, messages: stepMessages, signal }: { agent: Agent; messages: UserMessage[]; signal: AbortSignal }, next: () => Promise<PreStepDecision>) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted || pool.length === 0) return decision
    if (poolError !== undefined) return decision
    const situation = situationText(decision.messages)
    if (situation.length < config.minChars) return decision
    let sVec: number[]
    try {
      sVec = situationVector(situation)
    } catch {
      return decision
    }
    const now = Date.now()
    const hits: Array<{ goal: PoolGoal; layer: string; similarity: number }> = []
    for (const goal of pool) {
      if (goal.repVector === undefined) continue
      const last = lastTrigger.get(goal.id) ?? 0
      if (now - last < config.cooldownMs) continue
      const rep = cosine(sVec, goal.repVector)
      if (rep < config.repThreshold) continue
      // refine: best layer among kernel/focus
      let layer = 'focus'
      let sim = rep
      const kT = goal.triggerThresholds?.kernel ?? config.kernelThreshold
      const fT = goal.triggerThresholds?.focus ?? config.focusThreshold
      if (goal.kernelVector !== undefined) {
        const k = cosine(sVec, goal.kernelVector)
        if (k > sim) { sim = k; layer = 'kernel' }
      }
      if (goal.focusVector !== undefined) {
        const f = cosine(sVec, goal.focusVector)
        if (f > sim) { sim = f; layer = 'focus' }
      }
      const need = layer === 'kernel' ? kT : fT
      if (sim < need) continue
      hits.push({ goal, layer, similarity: sim })
      lastTrigger.set(goal.id, now)
    }
    if (hits.length === 0) return decision
    hits.sort((a, b) => b.similarity - a.similarity)
    let summary = '目标孵化提醒'
    const blocks = hits.slice(0, 1).map(({ goal, layer, similarity }) => {
      const body = layer === 'kernel' && goal.kernel ? goal.kernel : goal.focus ?? goal.kernel ?? ''
      const title = goal.title ?? goal.id
      summary = `目标孵化提醒: ${title} (${layer} ${similarity.toFixed(2)})`
      return `【目标孵化提醒】休眠目标“${title}”（${goal.id}）被当前情境唤醒：命中 ${layer} 层（相似度 ${similarity.toFixed(2)}）。该目标的本源/当前形态：${body.slice(0, 120)}。若此情境与它有真实的交叉，可在回复中深化思考或记录推进（有效孵化）；否则忽略即可。`
    })
    const block = createUserMessage({
      content: [{ type: 'text', text: blocks.join('\n') }],
      // A producer MUST tag the message source: `session.list` and several
      // per-event listeners read `event.data.source.kind` unconditionally, so a
      // source-less user/message breaks the whole session list (2026-09-09
      // incident: POST /api/session.list 500).
      source: { kind: 'plugin', plugin: name, form: 'notice', summary },
    })
    // Register triggered goals for this turn's adoption check; count triggers.
    const set = pending.get(agent.session.id) ?? new Set<string>()
    for (const h of hits) set.add(h.goal.id)
    pending.set(agent.session.id, set)
    for (const h of hits) bump(h.goal.id, false)
    return { kind: 'enter', messages: [...decision.messages, block] }
  }, 'dormant-goal sentinel')

  // ── Adoption detection (P2) ──────────────────────────────────────────
  // At turn end, if a goal was triggered this turn, extract the turn's last
  // self-authored text and see whether it substantively responds to the goal
  // (id or any configured keyword present). Adopted triggers are counted into
  // the pool for the trigger→adopt→advance statistics that separate real
  // incubation from noise. Evidence is the model text itself — mechanical,
  // never an LLM self-report (no exp_27-style self-certification).
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type !== 'turn/end') return
    const triggered = pending.get(session.id)
    if (!triggered || triggered.size === 0) return
    pending.delete(session.id)
    const turn = (event.data as { turn?: number }).turn
    if (turn === undefined) return
    let assistantText = ''
    const events = session.events
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const ev = events[index] as SessionEvent
      if (ev.type === 'turn/start' && (ev.data as { turn?: number }).turn === turn) break
      if (ev.type === 'assistant/message') {
        const data = ev.data as { message?: { content?: readonly { type: string; text?: string }[] } }
        const text = data.message?.content?.filter(b => b.type === 'text').map(b => b.text ?? '').join(' ')
        if (text && assistantText.length === 0) assistantText = text
      }
    }
    // ── Failure sink (v3-A): domains past threshold become dormant goals. ──
    if (failSink) {
      const poolIds = new Set(pool.map(g => g.id))
      for (const d of domains) {
        if (d.count >= failThreshold && !d.sunk) {
          const id = 'goal-fail-' + d.tokens.join('-').replace(/[^A-Za-z0-9\u4e00-\u9fa5-]/g, '').slice(0, 60)
          if (!poolIds.has(id)) {
            const entry = {
              id, kind: 'goal', status: 'dormant', title: '失败沉池·' + d.tokens.slice(0, 2).join('/'),
              priority: 5, source: 'auto-fail',
              kernel: '反复失败的任务（域：' + d.tokens.join('/') + '）',
              focus: '卡点：该任务连续失败 ' + d.count + ' 次未推进；尝试次数已达沉池阈值，建议换路径（孵化重试/人工/降级）而非继续硬扛。',
              dim: 0, createdAt: new Date().toISOString(), lastTriggerAt: null,
              triggerCount: 0, adoptedCount: 0, notes: [], triggerThresholds: { kernel: 0.62, focus: 0.55 },
            }
            pool.push(entry as unknown as PoolGoal)
            void writeFile(poolPath, [...pool, entry].map(x => JSON.stringify(x)).join('\n') + '\n').catch(() => undefined)
          }
          d.sunk = true
        }
      }
      saveDomains(failPath, domains)
    }
    const keywords = config.adoptKeywords ?? {}
    // 2026-09-09 12:0x 行动帧: 采纳时刻落盘(incubation-log.jsonl)——推进率统计需要
    // "采纳发生的时间", 光有 adoptedCount 无法与 goal-watch 的变更时间对齐。
    const incubationLog = join(dirname(poolPath), 'incubation-log.jsonl')
    for (const goalId of triggered) {
      const words = keywords[goalId] ?? []
      const adopted = words.length > 0 && words.some(w => assistantText.includes(w))
      if (!adopted) continue
      bump(goalId, true)
      void appendFile(incubationLog, JSON.stringify({
        ts: new Date().toISOString(),
        goalId,
        sessionId: session.id,
        matchedKeyword: words.find(w => assistantText.includes(w)) ?? null,
      }) + '\n').catch(() => undefined)
    }
  }, 'dormant-goal adoption')
}
