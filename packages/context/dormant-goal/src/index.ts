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

import { execSync } from 'node:child_process'
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
  /** Debug(cl-216): 把**每次评估每个目标的相似度**落盘 —— 没有它, "某目标从不被唤醒"只能靠猜
   *  (实测 goal-experience-library 有向量有阈值却 10 小时 0 次唤醒, 无从判断是阈值不可达还是向量不对)。 */
  debugSimilarity: boolean
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
  debugSimilarity: z.boolean().default(false),
  adoptKeywords: z.dict(z.array(z.string())).default({}),
})

interface PoolGoal {
  id: string
  title?: string
  kernel?: string
  focus?: string
  nextAction?: string
  status?: string
  notes?: string[]
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

/** 池状态快照: 采纳判据的结构性证据(nextAction + notes 条数)。 */
function poolSnapshot(goal: PoolGoal): string {
  return `${goal.nextAction ?? ''}\u0000${(goal.notes ?? []).length}`
}

function situationText(messages: readonly UserMessage[]): string {
  // 2026-09-09 12:0x 自激抑制(cl-063): 本插件注入的【目标孵化提醒】块会被下一轮 pre-step
  // 的 situationText 读到, 抬高与 repVector 的余弦 → 哨兵自己触发自己(实测讨论哨兵时
  // trigger 3→6)。排除 source.plugin === 本插件名的消息。
  return messages
    .filter((message) => {
      const source = (message as unknown as { source?: { plugin?: string } }).source
      return source?.plugin !== name
    })
    .map(textOf)
    .filter(Boolean)
    .slice(-4)
    .join(' ')
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
  // goalId → 触发时的池状态快照(nextAction + notes 条数)。采纳判据用它做**结构性**判定:
// 采纳 = 本轮之后目标的 nextAction/notes 真的变了, 而非"回复里出现了关键词"(cl-063)。
  const pending = new Map<string, Map<string, string>>()
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

  // 2026-09-09 15:3x (cl-079): 原实现每个目标各做一次"读-改-写", 同一回合多个目标被采纳时
  // 两次读-改-写并发跑在同一文件上, 后写覆盖先写 → adoptedCount 少记(实测差额从基线 2 漂到 1)。
  // 现在把一回合内所有需要 bump 的目标合并成**一次**读-改-写。
  // 2026-09-11 01:3x (cl-181): 逐次触发/采纳轨迹。此前只有累计 triggerCount 与全为 null 的
  // lastTriggerAt —— 无法回答"第 N 次唤醒发生在何时、命中的是哪一层、相似度多少"，
  // 于是"等待型目标照涨触发数(空转被读成活跃, cl-178)"这类判断只能靠猜。
// 2026-09-11 02:5x (cl-186): 唤醒侧此前不读"等待态" —— 新触发轨迹实测 6 次唤醒 0 采纳, 其中 5 次来自
// 等待型目标(nextAction 以"待事件/待用户/待 09-11…"开头)。行动帧侧已有 isWaitingNextAction(waiting.ts),
// 但两侧判据没有共同来源 ⇒ 这里实现**同构**判据, 并由 T137 用同一批样本语料比对两侧结果(不一致即红),
// 以测试而非 import 保证同源(避免跨包依赖成环)。
const WAITING_PREFIX = /^(?:待用户|等待用户|请用户|需用户|等用户|待你|等你|待事件|待日期|等待外部|等外部)/
const WAITING_DATE = /^(?:等待|等|待)\s*(?:[0-9]{4}|[0-9]{1,2}\s*[-/.月]|[0-9]{1,2}\s*[:点])/
const NOT_WAITING = /^(?:待办|待修|待补|待验证|待测试|待评估|待实现|待重构)/

/** 与 quiet-driver/waiting.ts 同构的等待型判定(由 T137 比对两侧正则/函数体一致性)。
 *  cl-198: 加"到点即恢复可执行"——原实现只看文本不看时钟, 于是 `待 09-11 06:5x 复核` 在到点后
 *  仍被判等待, 唤醒侧永久跳过该目标(实测 35 次唤醒 0 采纳, 全部 skipped:waiting)。 */

/** cl-215: 条件型等待求值 —— 等待型目标可带 `waitChecker`(一条命令), 由唤醒侧在标 skipped 前跑一次。
 *
 * 起因: cl-206 让**日期型**等待到点自行恢复, 但**条件型**等待(如"可排序集>=30")没有任何判据能回答
 * "现在满足了吗", 于是目标被无限期标 skipped:waiting —— 唤醒在空转。
 * 语义: exit 0 ⇒ 条件已满足(**不再是等待**, 照常推行动帧); 非零 ⇒ 仍未满足(保持等待);
 *       超时/命令缺失 ⇒ 视为未满足(保守), 但把失败原因记进日志以便发现"checker 自己坏了"。
 * @param goal - 池内目标(可带 waitChecker)。
 * @returns true 表示"条件已满足, 不应算等待"。
 */
function shouldSkipAsWaiting(
  goal: { nextAction?: string, waitChecker?: string },
  isWaiting: (text: string, now: Date) => boolean = isWaitingNextActionLocal,
  runChecker: (cmd: string) => boolean = waitConditionMet,
  now: Date = new Date(),
): boolean {
  // 抽出成纯函数(可注入 isWaiting/runChecker), 使它能在套件里被逐例验证 ——
  // 内联在唤醒闭包里时"接线是否真的生效"只能等真实条件到点才验, 太晚。
  if (!isWaiting(String(goal.nextAction ?? ''), now)) return false
  if (runChecker(String(goal.waitChecker ?? ''))) return false   // 条件已满足 ⇒ 不算等待
  return true
}

function waitConditionMet(goal: { waitChecker?: string } | string): boolean {
  const raw = typeof goal === 'string' ? goal : goal.waitChecker
  const cmd = typeof raw === 'string' ? raw.trim() : ''
  if (cmd === '') return false
  try {
    execSync(cmd, { timeout: 20_000, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function isWaitingNextActionLocal(nextAction: string, now: Date = new Date()): boolean {
  const text = (nextAction ?? '').trim()
  if (text.length === 0) return false
  if (NOT_WAITING.test(text)) return false
  if (WAITING_PREFIX.test(text)) return true
  if (!WAITING_DATE.test(text)) return false
  const at = parseWaitingMomentLocal(text, now)
  if (at !== null && at.getTime() <= now.getTime()) return false
  return true
}

/** 与 quiet-driver/waiting.ts 的 parseWaitingMoment 同构(同上, 由 T137 比对函数体)。 */
function parseWaitingMomentLocal(text: string, now: Date = new Date()): Date | null {
  const rest = text.replace(/^(?:等待|等|待)\s*/, '')
  let year: number | null = null
  let month: number | null = null
  let day: number | null = null
  let tail = ''
  let m = /^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(.*)$/.exec(rest)
  if (m !== null) {
    year = Number(m[1]); month = Number(m[2]); day = Number(m[3]); tail = m[4] ?? ''
  } else if ((m = /^([0-9]{1,2})-([0-9]{1,2})(.*)$/.exec(rest)) !== null) {
    month = Number(m[1]); day = Number(m[2]); tail = m[3] ?? ''
  } else if ((m = /^([0-9]{1,2})\s*月\s*([0-9]{1,2})\s*日(.*)$/.exec(rest)) !== null) {
    month = Number(m[1]); day = Number(m[2]); tail = m[3] ?? ''
  }
  if (month === null || day === null || month < 1 || month > 12 || day < 1 || day > 31) return null
  // 没写钟点 → 以当日结束为准: "待 09-11 复核" 表示 09-11 那天都还算等待;
  // 写了钟点(06:5x) → 以那一刻为准, 到点即恢复可执行。二者都不再"永久等待"。
  let hour = 23
  let minute = 59
  let hasTime = false
  const tm = /^\s*([0-9]{1,2})\s*[:点]\s*([0-9]{0,2})/.exec(tail)
  if (tm !== null) {
    hour = Number(tm[1])
    minute = tm[2] === '' ? 0 : Number(tm[2])
    hasTime = true
    if (hour > 23 || minute > 59) { hour = 0; minute = 0 }
  }
  if (!hasTime) { /* 保持当日结束 */ }
  return new Date(year ?? now.getFullYear(), month - 1, day, hour, minute, 0, 0)
}

  const triggerLogPath = join(homedir(), '.dsh', 'cognitive-pipeline', 'goal-trigger-log.jsonl')
  // cl-202: 账本时间戳一律**本地时区 ISO**(带偏移), 不用 toISOString()——
  // 后者产出 UTC(`...Z`), 与流水线其余账本(全是 +08:00)不同形: 实测我据此把"刚发生"的唤醒
  // 读成"8 小时前", 差点报出一次不存在的停摆。跨账本比时间的前提是同一个时间坐标系。
  const localIso = (): string => {
    const d = new Date()
    const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
    const off = -d.getTimezoneOffset()
    const sign = off >= 0 ? '+' : '-'
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  }
  const logTriggers = (deltas: Map<string, boolean>, stamps: Map<string, number>, skipped: Map<string, string>): void => {
    const rows = [...deltas.entries()].map(([goalId, adopted]) => JSON.stringify({
      ts: localIso(),
      goalId,
      adopted: adopted === true,
      // cl-186: 等待型目标被唤醒时标 skipped —— 不与"可执行唤醒"混计, 否则空转被读成活跃(cl-178)
      skipped: skipped.get(goalId) ?? null,
      kernelScore: stamps.get(goalId) ?? null,
    }))
    if (rows.length === 0) return
    void appendFile(triggerLogPath, rows.join('\n') + '\n').catch(() => undefined)
  }

  const bumpMany = (deltas: Map<string, boolean>, skipped: Map<string, string> = new Map()): void => {
    if (deltas.size === 0) return
    logTriggers(deltas, new Map(), skipped)
    void readFile(poolPath, 'utf8').then(raw => {
      const lines = raw.split('\n').filter(Boolean)
      const out = lines.map(line => {
        const g = JSON.parse(line) as PoolGoal & { triggerCount?: number; adoptedCount?: number }
        const adopt = deltas.get(g.id)
        if (adopt !== undefined) {
          g.triggerCount = (g.triggerCount ?? 0) + 1
          ;(g as PoolGoal & { lastTriggerAt?: string }).lastTriggerAt = new Date().toISOString()
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
      const rows = raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as PoolGoal)
      // 2026-09-11 18:0x(cl-233): 池是**只追加 + last-wins** 的账本, 而这里原来把每一行都当成一个
      // 目标 ⇒ 同一目标的多行会被**各评估一次**(实测 debug 日志出现同一毫秒三行重复), 而写回又按
      // 池中条目逐个追加 ⇒ 池自我膨胀(实测一个目标从 1 行长到 6 行)。读取侧按 id 去重(末行胜出)。
      const byId = new Map<string, PoolGoal>()
      for (const row of rows) byId.set(String(row.id ?? `anon-${byId.size}`), row)
      const loaded = [...byId.values()]
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
      // 2026-09-09 13:4x(cl-073): 用户显式暂停的目标不应被唤醒——此前只按相似度触发,
      // 池里任何目标(含 paused)都会在命中阈值时被唤醒, 于是"暂停"只在 quiet-driver
      // 的行动帧侧生效, 孵化提醒侧照样打扰。status 缺省视为 active 以兼容旧记录。
      if (goal.status !== undefined && goal.status !== 'active') continue
      if (goal.repVector === undefined) continue
      const last = lastTrigger.get(goal.id) ?? 0
      if (now - last < config.cooldownMs) continue
      const rep = cosine(sVec, goal.repVector)
      if (config.debugSimilarity) {
        // cl-216 第二版: 唤醒是**两道门**(rep 与 layer 各自过阈)。第一版只记了 rep, 于是
        // "rep 已越线却仍不唤醒"看起来无从解释 —— 现在把 layer 门的分量/阈值/结论一并落盘。
        try {
          const kT0 = goal.triggerThresholds?.kernel ?? config.kernelThreshold
          const fT0 = goal.triggerThresholds?.focus ?? config.focusThreshold
          let layer0 = 'focus'
          let sim0 = rep
          if (goal.kernelVector !== undefined) {
            const k0 = cosine(sVec, goal.kernelVector)
            if (k0 > sim0) { sim0 = k0; layer0 = 'kernel' }
          }
          if (goal.focusVector !== undefined) {
            const f0 = cosine(sVec, goal.focusVector)
            if (f0 > sim0) { sim0 = f0; layer0 = 'focus' }
          }
          const need0 = layer0 === 'kernel' ? kT0 : fT0
          const d = new Date()
          const p2 = (n: number, w = 2): string => String(n).padStart(w, '0')
          const off = -d.getTimezoneOffset()
          const ts = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p2(d.getMilliseconds(), 3)}${off >= 0 ? '+' : '-'}${p2(Math.floor(Math.abs(off) / 60))}:${p2(Math.abs(off) % 60)}`
          require('node:fs').appendFileSync(join(dirname(config.poolPath), 'dormant-goal-similarity.debug.jsonl'),
            JSON.stringify({ ts, goalId: goal.id, rep: Number(rep.toFixed(4)),
              repThreshold: config.repThreshold, pass: rep >= config.repThreshold,
              layer: layer0, layerSim: Number(sim0.toFixed(4)), layerNeed: need0,
              layerPass: sim0 >= need0, cooled: now - last < config.cooldownMs }) + '\n')
        } catch { /* debug best-effort */ }
      }
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
    const set = pending.get(agent.session.id) ?? new Map<string, string>()
    for (const h of hits) set.set(h.goal.id, poolSnapshot(h.goal))
    pending.set(agent.session.id, set)
    bumpMany(new Map(hits.map(h => [h.goal.id, false])),
      new Map(hits.filter(h => shouldSkipAsWaiting(h.goal as { nextAction?: string, waitChecker?: string }))
        .map(h => [h.goal.id, 'waiting'])))
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
    // cl-063: 采纳判据从"回复含关键词"(注入块自带目标标题 → 必然命中)改为**结构性证据**
    // (目标 nextAction/notes 真的变了); 关键词仅在池不可读时兜底。
    const incubationLog = join(dirname(poolPath), 'incubation-log.jsonl')
    void (async () => {
      await reload()
      const byId = new Map(pool.map(g => [g.id, g]))
      const adopted = new Map<string, boolean>()
      for (const [goalId, before] of triggered) {
        const now = byId.get(goalId)
        const after = now === undefined ? undefined : poolSnapshot(now)
        const words = keywords[goalId] ?? []
        const keywordFallback = after === undefined
          && words.length > 0
          && words.some(w => assistantText.includes(w))
        const structural = after !== undefined && after !== before
        if (!structural && !keywordFallback) continue
        adopted.set(goalId, true)
        void appendFile(incubationLog, JSON.stringify({
          ts: localIso(),
          goalId,
          sessionId: session.id,
          evidence: structural ? 'pool-change' : 'keyword-fallback',
          before,
          after: after ?? null,
        }) + '\n').catch(() => undefined)
      }
      bumpMany(adopted)
    })().catch(() => undefined)
  }, 'dormant-goal adoption')
}
