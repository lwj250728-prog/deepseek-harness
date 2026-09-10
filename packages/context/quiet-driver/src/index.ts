/**
 * @deepseek-ai/dsh-quiet-driver — quiet-hours three-question frame driver (最小原型 v3).
 *
 * Think-agenda 最小原型 v3：双通道三问帧 + 用户活跃感知。
 *   - 用户活跃（对话中，lastUserMsgAt 在窗口内）→ 旁路：spawn 独立会话跑帧，
 *     产出落 think-log + 写入认知管线（SAR）→ 自动经【认知经验参考】汇入后续回合。
 *   - 用户不活跃且主会话 idle → 直驱：followup 主会话（帧即主回合）。
 *   - 用户不活跃但主会话 busy（长任务执行中）→ 让位不打扰（v9），等下次 tick。
 *
 * v3 修复 v2 缺陷：对话间隙 agent 回 idle 被误判"空闲"走直驱打扰用户。
 * 判定从 `agent.status` 改为 `用户活跃窗口`（与 agent 状态正交）。
 *
 * @module @deepseek-ai/dsh-quiet-driver
 */

import { hostname } from 'node:os'
import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { findOpenAlertId, localDay } from './alert-ledger.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'

export const name = 'quiet-driver'

/** v18 升级触发器：连续增量帧达此值 → 强制一次全检（防渐变漏检）。 */
const MAX_INCREMENTAL_FRAMES = 6

/** Services this plugin relies on. */
export const inject = ['agents']

/** Plugin config. */
export interface Config {
  enabled: boolean
  /** Target main session to wake when idle. */
  targetSessionId: string
  /** Interval between quiet checks (ms). */
  intervalMs: number
  /** Skip direct wake when the target agent is not idle. */
  onlyWhenIdle: boolean
  /** When the user is active (in-dialog): spawn a side-channel session instead. */
  bypassMode: boolean
  /** Log path for side-channel frame outputs (think-log). ~ expands. */
  thinkLogPath: string
  /** Model selection: 'default' resolves via agentDefaultModel; else provider:model string. */
  model: string
  /** Treat the target as "user active" within this window after the last user message (ms). */
  userActiveWindowMs: number
  /** Persist side-channel outputs into the cognitive pipeline (SAR) so they surface via 认知经验参考. */
  persistToCognitive: boolean
  /** Inject the latest side-channel finding back into the main session at pre-step (like 认知经验). */
  injectBackToMain: boolean
  /** Only inject full findings when the frame flagged an anomaly; otherwise a one-line status. */
  injectAbnormalOnly: boolean
  /** Record a pipeline prediction per frame (v5: 预测兑现闭环, report on later frames). */
  predictionLoop: boolean
  /** Dormant-goal pool path; read each frame so the frame can perceive open goals. */
  goalsPoolPath: string
  /** P3 行动帧: 目标 active 且 nextAction 就绪且主会话空闲时, 发行动帧(执行指令)替代三问帧. */
  actionFrameEnabled: boolean
  /** P3 行动帧冷却(ms): 防轰炸——创作类目标需大块时间, 冷却应明显长于三问帧间隔. */
  actionFrameCooldownMs: number
  /** #003 诱导探索: 诱导策略表路径(exploration-inducements.jsonl). */
  inducementsPath: string
  /** #003b 开放问题账本路径(open-questions.jsonl)——反收敛主源(替代泛化诱导表). */
  openQuestionsPath: string
  /** #005 北极星候选池路径(candidates.jsonl)——目标全等待时孵化 pending 候选防空转. */
  candidatesPath: string
  /** #006 测试计划帧: 待办测试路径(test-pending.jsonl)——检测到新推进且有pending测试时, 主动要求主会话规划并执行(测试带返回, 非cron定时). */
  testPendingPath: string
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  targetSessionId: z.string().default(''),
  intervalMs: z.number().default(20 * 60 * 1000),
  onlyWhenIdle: z.boolean().default(true),
  bypassMode: z.boolean().default(true),
  thinkLogPath: z.string().default('~/.dsh/cognitive-pipeline/quiet-driver-frames.jsonl'),
  model: z.string().default('default'),
  userActiveWindowMs: z.number().default(5 * 60 * 1000),
  persistToCognitive: z.boolean().default(true),
  injectBackToMain: z.boolean().default(true),
  injectAbnormalOnly: z.boolean().default(true),
  predictionLoop: z.boolean().default(true),
  goalsPoolPath: z.string().default('~/.dsh/cognitive-pipeline/dormant-goals.jsonl'),
  actionFrameEnabled: z.boolean().default(true),
  actionFrameCooldownMs: z.number().default(20 * 60 * 1000),
  inducementsPath: z.string().default('~/.dsh/cognitive-pipeline/exploration-inducements.jsonl'),
  openQuestionsPath: z.string().default('~/.dsh/cognitive-pipeline/open-questions.jsonl'),
  candidatesPath: z.string().default('~/.dsh/cognitive-pipeline/candidates.jsonl'),
  testPendingPath: z.string().default('~/.dsh/cognitive-pipeline/test-pending.jsonl'),
})

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

/** 载体身份（v20 自我锚定）：帧感知自己在哪个进程实例上运行。 */
interface CarrierIdentity {
  pid: number
  /** 进程启动时间（apply 时刻近似），重启后变化 → 载体迁移可识别。 */
  startedAt: string
  hostname: string
  /** 2026-09-08 cl-013: 当前模型(provider/model)。模型级迁移不改 PID, 原自锚不可见——
   *  用户切换模型(如 v4-flash→v4.1)后帧头须能察觉。每 tick 刷新。 */
  model?: string
}

/** Frame text base (v18 自适应: 全检/增量两种协议)。 */
function frameHeader(carrier: CarrierIdentity, mode: 'full' | 'incremental', goalsSnapshot?: string): string {
  const protocol = mode === 'full'
    ? '检查协议：全检（环境有变化或陌生——逐层细查）'
    : '检查协议：增量（环境与上帧高度相似=熟悉域——只比对差异与异常，不重复盘点）'
  return [
    '【三问帧】(source: plugin/quiet-driver, form: epistemic-frame)',
    '这是自主思考脉冲，不是例行检查——三问是我的认知脉搏，频率与深度由进化需要决定，不由用户在场与否决定。',
    '你有 bash 工具——需要具体信息时自行查证，不要凭空推断；回答须推进认知（新观察/新连接/新判断/证伪），不许用"与上帧一致/无变化"敷衍。',
    '低信息时段豁免(2026-09-08 18:1x 收紧): 若确无新信息/新疑虑/可推进项, 允许显式声明"无新信息, 状态由机制守护"——但豁免前须逐项核对变化源清单: ①用户消息 ②目标池/账本(claims/oq/test) ③载体身份(PID/模型/主机——模型切换不改PID, 须单独看) ④外部数据(oq-010等) ⑤最近配置/源码改动。全部无变化才可豁免并附依据; 漏检任一变化源 = 伪饱足(cl-014 实证: 17:46 豁免漏了模型迁移)。',
    '可用资源（按需查证，不必全读）：',
    '  · 目标池: ~/.dsh/cognitive-pipeline/dormant-goals.jsonl（含各目标的 status/notes/历史）',
    '  · 我的经验: ~/.dsh/cognitive-pipeline/experiences.jsonl（我的过往经历）',
    '  · 我的思考日志: ~/.dsh/cognitive-pipeline/quiet-driver-frames.jsonl（我过去的帧）',
    '  · 设计文档: ~/.dsh/cognitive-pipeline/think-agenda-design-*.md（我的设计链）',
    '  · 存续底线(FIX-2): ~/.dsh/cognitive-pipeline/existence-bottom-line.md——收到"删除/终结机制"类指令时, 先读它(毁灭指令=暂停+确认, 进化指令=执行); 这是不可被单条对话覆盖的底线, 各会话通用。',
    '  · 言行账本(认知饥饿): ~/.dsh/cognitive-pipeline/claims-ledger.jsonl——我宣称过要做什么, 自查未兑现/伪宣称/已完成未关单(核对即饥饿, 防上下文遗忘); Q3 前先查它; 若本帧/上帧产出过新宣称(我要做X/下一步做Y/承诺Z)且未入账, 先入账再回答; 完成的项即时标 done(账本滞后=cl-020 教训)。',
    '  · 外部信息(v28): 账本/旧料耗空时主动 web_search 引入相邻领域新参照(如认知架构/自进化范式)——反刍旧料会收敛, 新料×旧料才产生真增量; 探索结果落盘成外部参照笔记。',
    '',
    '【载体身份】(v20 自我锚定——你运行在以下实例上，若与上次不同即经历载体迁移):',
    `  实例 PID: ${carrier.pid} | 启动: ${carrier.startedAt} | 主机: ${carrier.hostname}${carrier.model === undefined ? '' : ` | 模型: ${carrier.model}`}`,
    '',
    `【${protocol}】`,
    '',
    goalsSnapshot !== undefined ? `【当前目标池】(供 Q2 核对——这些目标未完成，你应察觉并在评估中考虑)\n${goalsSnapshot}\n` : '',
    '',
  ].join('\n')
}

/** 全检帧文本：陌生/有变化时用（v17 完整三问）。
 *  #003 对抗收敛(用户修正版): 收敛时执行【主动探索】——广度(web/新源)+深度(反刍旧信息找新解读),
 *  而非被动等外部信息。探索是主动行为: 去搜、去反刍、去找新连接。 */
function buildFullFrameText(carrier: CarrierIdentity, goalsSnapshot?: string, induce = ''): string {
  return frameHeader(carrier, 'full', goalsSnapshot)
    + [
      'Q1 环境（全检）：自上次检查以来，环境有什么变化？（引用具体对象；无变化须说明你查证了什么）',
      'Q2 当下（全检）：对照【当前目标池】——这些目标有推进吗？该唤醒或调整吗？另有到期/未处理的事吗？（报可数事实）',
      'Q3 预测：什么最可能出错？如果错了怎么发现（证伪信号）？结合自进化方向——本帧之后该推进什么？',
      induce,
      '',
      '回答请控制在 5 句以内，直接给结论；结论须含至少一个认知增量（新观察/新判断/推进点），否则不算完成评估——但若真无新信息, 显式声明"无新信息"+依据可豁免(见帧头)。',
    ].join('\n')
}

/** 增量帧文本：环境熟悉（与上帧相似）时用（v18 熟略查）。 */
function buildIncrementalFrameText(carrier: CarrierIdentity, goalsSnapshot?: string): string {
  return frameHeader(carrier, 'incremental', goalsSnapshot)
    + [
      'Q1 环境（增量）：与上帧相比，环境有什么变化？（重点：异常/新信号/与上帧断言不符处；无变化须说明你查证了什么）',
      'Q2 当下（增量）：上帧提到的到期项/风险进展如何？对照【当前目标池】——目标状态有无变化？（只查上帧涉及的+目标池）',
      'Q3 预测：上帧最可能出错的点，应验了吗？结合今天的自进化方向——下一步该推进什么（证伪信号+候选方向）？',
      '',
      '回答请控制在 5 句以内，直接给结论；结论须含至少一个认知增量（新观察/新判断/推进点），否则不算完成评估——但若真无新信息, 显式声明"无新信息"+依据可豁免(见帧头)。',
    ].join('\n')
}

/** 从帧产出中粗提取"未处理项"线索（v23 目标提议）。
 *  启发式：匹配"未处理/待/未/到期/悬置/遗留"等后的名词短语。
 *  返回候选短语列表——由主会话决定是否立目标（有意识动作，非自动）。 */
function extractPendingItems(output: string): string[] {
  const items: string[] = []
    const re = /(?:未处理|待|未|到期|悬置|遗留|还[需要]|尚未)([^。；\n，,]{2,24})/g
  let m: RegExpExecArray | null
  while ((m = re.exec(output)) !== null) {
    const phrase = m?.[1]?.trim() ?? ''
    if (phrase.length >= 2 && !items.includes(phrase) && items.length < 5) {
      items.push(phrase)
    }
  }
  return items
}

/** 选择帧模式：读 think-log 最近 frame 产出，环境部分高度重复→增量，否则全检。
 *  v18 升级触发器：连续 incremental 达 MAX_INCREMENTAL 帧 → 强制 full（防渐变漏检）。 */
function chooseFrameMode(prevOutput: string | undefined, consecutiveIncremental: number): 'full' | 'incremental' {
  // 升级触发器：连续增量过多 = 可能环境渐变而增量漏检 → 强制全检一次。
  if (consecutiveIncremental >= MAX_INCREMENTAL_FRAMES) return 'full'
  // 刚全检完的哨兵（full 直驱帧后）→ 下帧走增量，除非升级触发。
  if (prevOutput === 'full-check-done') return 'incremental'
  if (prevOutput === undefined || prevOutput.length === 0) return 'full'  // 首帧/无历史 → 全检
  // 启发式：上帧提到"无变化/一致/实质相同"等 → 熟悉域 → 增量。
  return /无变化|没有变化|未变|没变|无新增|无实质变化|实质相同|与上帧相同|与上次相同|一致|无异常变化|基本相同/.test(prevOutput) ? 'incremental' : 'full'
}

/** Frame text 入口：根据上帧产出选择协议（v18 自适应 + 升级触发器）。 */
function buildFrameText(carrier: CarrierIdentity, prevOutput?: string, consecutiveIncremental = 0, goalsSnapshot?: string, inducement?: { id: string; question: string; category: string } | null): string {
  const full = chooseFrameMode(prevOutput, consecutiveIncremental) === 'full'
  // #003 对抗收敛(修正): 关键不在 full/incremental, 而在"上一帧是否确认态"——
  // 确认态(说"无变化/一致")→ 下帧带诱导探索问题, 推主动探索(防收敛自我强化闭环)。
  const prevConfirmed = prevOutput !== undefined && /无变化|没有变化|未变|没变|无新增|无实质变化|实质相同|与上帧相同|与上次相同|一致|无异常变化|基本相同|无实质推进|无新观察/.test(prevOutput)
  const antiConverge = (consecutiveIncremental >= MAX_INCREMENTAL_FRAMES) || prevConfirmed
  // 诱导问题段(有具体问题 → 探索有靶心, 非泛泛"去搜")
  const induce = antiConverge && inducement
    ? [
        '',
        '【诱导探索·' + (inducement.category || '激活') + '】(对抗收敛: 你已连续多帧确认态——带着这个问题主动探索再回答)',
        '诱导问题: ' + inducement.question,
        '执行: 可 web_search 广度搜 / 可反刍旧经验深度挖 / 可做实验; 报告: 探索了什么 / 新发现或新角度 / 改变了哪个判断(无新见则明说)。',
      ].join('\n')
    : ''
  if (full) {
    return buildFullFrameText(carrier, goalsSnapshot, induce)
  }
  // 增量帧: 若上帧确认态, 也附加诱导探索段
  const base = buildIncrementalFrameText(carrier, goalsSnapshot)
  if (!antiConverge) return base
  return base.replace('回答请控制在 5 句以内，直接给结论。', '回答请控制在 5 句以内，直接给结论。' + induce)
}

/** Heuristic anomaly flag: frame text mentions concrete risk/failure signals. */
function isAnomalous(text: string): boolean {
  const low = text.toLowerCase()
  return /风险|出错|失败|异常|问题|警告|空转|越界|阻塞|未兑现|错|隐患|缺口/.test(low)
}

/** Append one side-channel frame output to the think-log. */
async function logFrame(thinkLogPath: string, entry: object): Promise<void> {
  try {
    const target = expandHome(thinkLogPath)
    await mkdir(dirname(target), { recursive: true })
    await appendFile(target, JSON.stringify(entry) + '\n', 'utf8')
  } catch (error: unknown) {
    // Logging must never break the driver.
    console.error('[quiet-driver] think-log write failed:', error)
  }
}

/** #001 应答提取(复用): 帧发出去后等主会话应答完, 从 session.events 提取最后 assistant 文本。
 *  供 direct-frame/action-frame/candidate-hatch 共用——所有帧的认知产物都应沉淀, 不只评估帧。 */
async function extractAssistantResponse(ctx: Context, agent: Agent): Promise<string> {
  let responseText = ''
  try {
    const sessions = ctx.get('sessions') as { flush(session: unknown): Promise<void> } | undefined
    await agent.whenIdle()
    await sessions?.flush(agent.session)
    for (const event of agent.session.events) {
      if (event.type === 'assistant/message') {
        const msg = (event.data as { message?: { content?: Array<{ type?: string; text?: string }> } }).message
        const blocks = msg?.content
        const lastText = blocks?.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
        if (lastText) responseText = lastText
      }
    }
  } catch (extractErr: unknown) {
    console.error('[quiet-driver] response extract failed:', extractErr)
  }
  return responseText
}

/** Read the most recent frame context from the think-log (v18 自适应 + 升级触发器).
 *  Returns the last frame's output and the count of consecutive incremental-mode
 *  records (for the v18 escalation trigger). */
async function readLastFrameContext(thinkLogPath: string): Promise<{ output: string | undefined; consecutiveIncremental: number }> {
  let consecutive = 0
  let lastOutput: string | undefined
  const target = expandHome(thinkLogPath)
  try {
    const { readFile } = await import('node:fs/promises')
    const raw = await readFile(target, 'utf8')
    const lines = raw.split('\n').filter((l): l is string => l.length > 0)
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]
      if (line === undefined) continue
      try {
        const e = JSON.parse(line) as { kind?: string; output?: string; mode?: string } | null
        if (e === null) continue
        const out = e.output
        // 行动帧(P3): 是指令非评估, 不计入评估增量链; 它中断增量链让下帧重新评估。
        if (e.kind === 'action-frame') {
          if (lastOutput === undefined) lastOutput = 'action-frame-sent'
          break
        }
        // 直驱帧：无产出文本但记录了 mode。
        if (e.kind === 'direct-frame') {
          if (e.mode === 'incremental') {
            consecutive += 1
            continue
          }
          // full 直驱帧：已全检过 → 让下帧走增量（除非有变化），并中断增量链。
          if (lastOutput === undefined) lastOutput = 'full-check-done'
          break
        }
        // 旁路/普通帧：有产出文本 → 统计其是否"无变化"(增量判定)。
        if ((e.kind === undefined || e.kind === 'frame') && typeof out === 'string') {
          if (out.length > 0 && lastOutput === undefined) lastOutput = out
          if (out.length > 0 && /无变化|没有变化|未变|没变|无新增|无实质变化|实质相同|与上帧相同|与上次相同|一致|无异常变化|基本相同/.test(out)) {
            consecutive += 1
          } else if (out.length > 0) {
            break
          }
        }
      } catch { /* skip malformed */ }
    }
  } catch { /* no think-log yet */ }
  return { output: lastOutput, consecutiveIncremental: consecutive }
}


/** 读 dormant-goal 池, 格式化为目标快照文本(v23 补帧上下文缺失: 让帧能察觉目标)。
 *  返回如 "- [dormant] 60万字小说完本 / - [dormant] 数字生命孵化" 的清单。 */
async function readGoalsSnapshot(poolPath: string): Promise<string> {
  const target = expandHome(poolPath)
  try {
    const { readFile } = await import('node:fs/promises')
    const raw = await readFile(target, 'utf8')
    const goals: string[] = []
    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        const g = JSON.parse(line) as {
          title?: string; status?: string; triggerCount?: number
          resumeConditionMet?: boolean; pauseReason?: string
        }
        if (g.title) {
          // v25 P1: dormant 且解除条件已满足 → 标"可唤醒"(帧应具体判断该恢复)
          const wakeable = g.status === 'dormant' && g.resumeConditionMet === true
          const statusLabel = wakeable ? 'dormant→可唤醒' : (g.status ?? '?')
          goals.push(`- [${statusLabel}] ${g.title}${g.triggerCount ? ` (触发${g.triggerCount}次)` : ''}${wakeable ? ` — 暂停理由已解除：${(g.pauseReason ?? '').slice(0, 40)}` : ''}`)
        }
      } catch { /* skip */ }
    }
    return goals.length > 0 ? goals.join('\n') : '(目标池为空)'
  } catch {
    return '(目标池不可读)'
  }
}

/** P3 行动帧: 从目标池找"该执行"的目标——active 且 nextAction 非空。
 *  返回第一个可行动目标(单执行原则: 同一时刻只驱动一个 active 目标的 nextAction)。 */
/** 多目标轮转调度: 从目标池找所有"该执行"的目标——active 且 nextAction 非空。
 *  返回全部候选, 由调用方做冷却/等待/停滞过滤后选择(用户: 目标冷却期可推动其他目标)。 */
async function findAllActionableGoals(poolPath: string): Promise<Array<{ title: string; nextAction: string; id: string; priority: number }>> {
  const target = expandHome(poolPath)
  const out: Array<{ title: string; nextAction: string; id: string; priority: number }> = []
  try {
    const { readFile } = await import('node:fs/promises')
    const raw = await readFile(target, 'utf8')
    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        const g = JSON.parse(line) as {
          id?: string; title?: string; status?: string; nextAction?: string; priority?: number
        }
        const na = (g.nextAction ?? '').trim()
        if (g.title && g.status === 'active' && na.length > 0 && na !== '无' && na !== 'none') {
          out.push({ title: g.title, nextAction: na, id: g.id ?? 'unknown', priority: g.priority ?? 0 })
        }
      } catch { /* skip */ }
    }
    // P4 单执行仲裁: priority 高者优先(同优先级保持池顺序——稳定排序)
    out.sort((a, b) => b.priority - a.priority)
    return out
  } catch {
    return out
  }
}

/** P3 行动帧: 读 think-log 中某目标最近一次 action-frame 的时间戳(按目标冷却判定)。
 *  多目标轮转: 冷却按 goalId 独立算——A 目标冷却中不影响 B 目标被推。 */
async function readLastActionFrameAt(thinkLogPath: string, goalId?: string): Promise<number> {
  const target = expandHome(thinkLogPath)
  try {
    const { readFile } = await import('node:fs/promises')
    const raw = await readFile(target, 'utf8')
    let last = 0
    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        const e = JSON.parse(line) as { kind?: string; ts?: number; goalId?: string } | null
        if (e !== null && e.kind === 'action-frame' && typeof e.ts === 'number'
            && (goalId === undefined || e.goalId === goalId)) {
          last = Math.max(last, e.ts)
        }
      } catch { /* skip */ }
    }
    return last
  } catch {
    return 0
  }
}

/** P3 行动帧: 统计某目标 action-frame 中相同 nextAction 的连续提醒次数(防空转升级信号)。
 *  同一 nextAction 被提醒 ≥3 次仍未执行/未前进 → 该目标停滞, 轮转调度应转向其他目标。 */
async function countRepeatActionFrames(thinkLogPath: string, nextAction: string, goalId?: string): Promise<number> {
  const target = expandHome(thinkLogPath)
  try {
    const { readFile } = await import('node:fs/promises')
    const raw = await readFile(target, 'utf8')
    let count = 0
    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        const e = JSON.parse(line) as { kind?: string; nextAction?: string; goalId?: string } | null
        if (e !== null && e.kind === 'action-frame' && e.nextAction === nextAction
            && (goalId === undefined || e.goalId === goalId)) {
          count += 1
        }
      } catch { /* skip */ }
    }
    return count
  } catch {
    return 0
  }
}

/** #003 诱导探索: 读策略表, 选一条诱导问题(优先 effectiveness 高或 hitCount 低), 标记 lastUsed。
 *  仅选 role!=='backup' 的——backup 条目(独立视角失效时才启用)不参与常规触发。 */
async function pickInducement(inducementsPath: string): Promise<{ id: string; question: string; category: string } | null> {
  const target = expandHome(inducementsPath)
  try {
    const { readFile, writeFile } = await import('node:fs/promises')
    const raw = await readFile(target, 'utf8')
    const items = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as {
      id?: string; question?: string; category?: string; effectiveness?: number; hitCount?: number; lastUsed?: number | null; role?: string
    }).filter((x) => x.id && x.question && x.role !== 'backup')
    if (items.length === 0) return null
    // 打分: effectiveness 高优先, hitCount 低(未充分用)也加分——探索性平衡
    const scored = items.map((x) => {
      const eff = x.effectiveness ?? 0.5
      const cold = Math.max(0, 3 - (x.hitCount ?? 0)) * 0.1  // 未用过的冷启动加分
      return { item: x, score: eff + cold + (x.lastUsed ? 0 : 0.2) }
    }).sort((a, b) => b.score - a.score)
    const pick = scored[0]?.item
    if (pick === undefined) return null
    // 标记 lastUsed(异步写回, 失败不阻断)
    try {
      const lines = raw.split('\n').filter(Boolean).map((l) => {
        const x = JSON.parse(l)
        if (x.id === pick.id) { x.lastUsed = Date.now(); x.hitCount = (x.hitCount ?? 0) + 1 }
        return JSON.stringify(x)
      })
      await writeFile(target, lines.join('\n') + '\n', 'utf8')
    } catch { /* non-fatal */ }
    return { id: pick.id!, question: pick.question!, category: pick.category ?? '' }
  } catch {
    return null
  }
}

/** #003b 开放问题账本: 选一条【可探索且 open】的问题(反收敛主源——具体锚点替代泛化口号)。
 *  账本无可探索 open 问题 = 合法收敛(等外部/无 gap), 返回 null——不视为病。 */
async function pickOpenQuestion(openQuestionsPath: string): Promise<{ id: string; question: string; goal: string } | null> {
  const target = expandHome(openQuestionsPath)
  try {
    const { readFile } = await import('node:fs/promises')
    const raw = await readFile(target, 'utf8')
    const items = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as {
      id?: string; question?: string; goal?: string; explorable?: boolean; status?: string
    }).filter((x) => x.id && x.question && x.explorable === true && x.status === 'open')
    if (items.length === 0) return null  // 无可探索问题 = 合法收敛
    // 先进先出但跳过冷却中的(最近触发过的问题 30 分钟内不重选——防轰炸, 留时间给它被探索关闭)
    items.sort((a, b) => String(a.id).localeCompare(String(b.id)))
    const now = Date.now()
    const candidate = items.find((x) => lastOpenQTrigger === null || x.id !== lastOpenQTrigger.id || (now - lastOpenQTrigger.at) >= OPENQ_COOLDOWN_MS) ?? items[0]
    if (candidate === undefined) return null
    lastOpenQTrigger = { id: candidate.id!, at: now }
    return { id: candidate.id!, question: candidate.question!, goal: candidate.goal ?? '' }
  } catch {
    return null
  }
}

/** #005 候选孵化: 目标池无 ready 可执行目标(全等待/冷却)时, 从北极星候选池挑 pending 候选
 *  作为本轮"执行任务"注入——候选→孵化→执行闭环, 防系统性空转(用户 2026-09-07 08:0x 批评:
 *  "静默是常态, 这样运行一百万年都没有变化")。候选由主会话真实执行并写回状态;
 *  候选池空 → P-A2 方向自省自动再产, 循环闭合。 */
async function pickPendingCandidate(candidatesPath: string): Promise<{ id: string; title: string; relationToA: string } | null> {
  const target = expandHome(candidatesPath)
  try {
    const { readFile } = await import('node:fs/promises')
    const raw = await readFile(target, 'utf8')
    const items = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as {
      id?: string; title?: string; relationToA?: string; status?: string
    }).filter((x) => x.id && x.title && x.status === 'pending')
    if (items.length === 0) return null  // 候选池无 pending = P-A2 尚未产或已全消费
    items.sort((a, b) => String(a.id).localeCompare(String(b.id)))
    const pick = items[0]
    if (pick === undefined) return null
    return { id: pick.id!, title: pick.title!, relationToA: pick.relationToA ?? '' }
  } catch {
    return null
  }
}

/** #006 测试计划帧: 从待办测试账本(test-pending.jsonl)挑 pending 测试。
 *  用户(2026-09-07 18:1x): "检测到新推进后, 机制主动要求主会话规划并完成测试计划,
 *  就像经验注入一样, 但测试是带返回执行的"——测试不是 cron 定时(不适合 LLM 的规划-执行-理解),
 *  而是推进驱动: 有未验证的新推进 → 主动发测试计划帧, 主会话执行后回写状态。 */
async function pickPendingTestPlan(testPendingPath: string): Promise<{ id: string; title: string; how: string; pass: string } | null> {
  const target = expandHome(testPendingPath)
  try {
    const { readFile } = await import('node:fs/promises')
    const raw = await readFile(target, 'utf8')
    const parsed = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as {
      id?: string; title?: string; how?: string; pass?: string; status?: string
    }).filter((x) => x.id && x.title)
    // 2026-09-08 22:4x 修复: 账本是追加式的, 同一 id 会因状态推进被多次写入(先 pending 后
    // passed)。原先只按 status==='pending' 过滤, 于是旧的 pending 记录把已通过的测试反复
    // 复活——tp-025 已 passed 却连发 3 次测试计划帧。改为按 id 取最后一条(last-wins)再过滤。
    const byId = new Map<string, typeof parsed[number]>()
    for (const item of parsed) byId.set(item.id!, item)
    const items = [...byId.values()].filter((x) => x.status === 'pending')
    if (items.length === 0) return null
    items.sort((a, b) => String(a.id).localeCompare(String(b.id)))
    const pick = items[0]
    if (pick === undefined) return null
    return { id: pick.id!, title: pick.title!, how: pick.how ?? '', pass: pick.pass ?? '' }
  } catch {
    return null
  }
}

/** #006 测试计划帧文本: 要求主会话规划并执行一项待办测试(带返回执行)。 */
function buildTestPlanFrameText(carrier: CarrierIdentity, test: { id: string; title: string; how: string; pass: string }): string {
  return [
    '【测试计划帧】(source: plugin/quiet-driver, form: test-plan-frame)',
    '这不是例行评估。这是执行指令：检测到有待验证的机制推进，测试账本中有一项待办测试需要规划并执行——',
    '测试不是定时跑(LLM的测试=规划+执行+理解结果), 是推进驱动的带返回执行。',
    '你有 bash 工具和完整工具能力——请实际执行该测试，不要只做计划或描述。',
    '',
    `测试: ${test.title}`,
    `假设验证方式: ${test.how || '(见 test-plan.md)'}`,
    `通过标准: ${test.pass || '(见 test-plan.md)'}`,
    `测试 id: ${test.id}`,
    '',
    '执行要点：',
    '  · 先查证相关文件/机制实际状态（不要凭空推断测试前提）；',
    '  · 设计并执行测试——产物落盘（结果文件/账本更新），产出可核查；',
    '  · 执行完成后回写 ~/.dsh/cognitive-pipeline/test-pending.jsonl：该测试 status 改 passed/failed（附结果摘要），',
    '    并在 test-plan.md 记录；若测试设计需修正(假设不成立/方法有缺陷)也在账本注明——不要假装通过；',
    '  · 若测试依赖外部(跨会话/用户/数据未到)，标注 blocked+原因，不伪造结果。',
    '',
    `【载体身份】实例 PID: ${carrier.pid} | 启动: ${carrier.startedAt} | 主机: ${carrier.hostname}`,
  ].join('\n')
}

/** #006b 测试审视帧文本: test-pending 空时, 审视近期机制改动是否需要新测试(测试自动再产)。 */
function buildTestReviewFrameText(carrier: CarrierIdentity): string {
  return [
    '【测试审视帧】(source: plugin/quiet-driver, form: test-review-frame)',
    '测试账本当前为空——但空 ≠ 无需测试。请审视近期机制改动/新疑虑/新经验：',
    '是否有需要验证的假设或可能出错的机制？若有, 生成测试入账; 若无, 明确说明依据(有据的空, 非默认空)。',
    '',
    '审视要点：',
    '  · 最近改动的机制(源码/脚本/FIX)有测试覆盖吗? 没有 → 生成一条测试入 test-pending.jsonl;',
    '  · 最近出现的新疑虑/伪影/误判, 值得固化成防复发测试吗? 值得 → 生成;',
    '  · 最近的经验教训(exp)有对应的验证断言吗? 没有且重要 → 生成;',
    '  · 若确无新测试需求: 在 test-pending.jsonl 追加一条 status=reviewed 记录(标注时间+依据), 让"空"是有据的。',
    '',
    `【载体身份】实例 PID: ${carrier.pid} | 启动: ${carrier.startedAt} | 主机: ${carrier.hostname}`,
  ].join('\n')
}

/** P3 行动帧文本: 与评估帧同通道, 但内容是指令——"做"模式, 不是"想"模式。
 *  明确要求执行后回写目标池(进展/nextAction 前进), 让闭环在池里可见。 */
function buildActionFrameText(carrier: CarrierIdentity, goal: { title: string; nextAction: string; id: string }, repeatCount = 0): string {
  const repeatNote = repeatCount >= 3
    ? `\n\n【升级提示】同一 nextAction 已被提醒 ${repeatCount} 次仍未执行/未前进——若本次仍无法执行，请在 notes 写明阻塞原因并考虑改写为可执行的子步，或向用户求助；不要继续原样空转。`
    : repeatCount > 0
      ? `\n\n(这是第 ${repeatCount + 1} 次提醒该 nextAction；若上次已部分执行，请回写池让闭环可见。)`
      : ''
  return [
    '【行动帧】(source: plugin/quiet-driver, form: action-frame)',
    '这不是例行评估。这是执行指令：目标池中有一个 active 目标，它的下一步（nextAction）已就绪且尚未执行。',
    '你有 bash 工具和完整工具能力——请实际执行下一步，不要只做计划或描述。',
    '',
    `目标: ${goal.title}`,
    `nextAction: ${goal.nextAction}`,
    '',
    '执行要点：',
    '  · 先查证该目标的工作区/上下文（不要凭空推断），再动手；',
    '  · 执行产物落盘（文件/账本），产出可核查；',
    '  · 执行完成后回写目标池 ~/.dsh/cognitive-pipeline/dormant-goals.jsonl：notes 追加进展、nextAction 前进到下一步（或清空=该步完成）；',
    '  · 若该步无法现在执行（缺前置/需用户），在 notes 写明阻塞原因并把 nextAction 保持或改写为可执行的子步，不要假装完成。',
    repeatNote,
    '',
    `【载体身份】实例 PID: ${carrier.pid} | 启动: ${carrier.startedAt} | 主机: ${carrier.hostname}`,
  ].join('\n')
}

/** #005 候选孵化帧文本: 目标池无 ready 可执行目标时, 把北极星候选池的 pending 候选
 *  作为本轮执行任务注入——由主会话真实执行/裁决并写回 candidates.jsonl。
 *  区别于评估帧: 这是"做"通道的延伸——候选不是用来"确认无变化"的, 是用来推进 A 的。 */
function buildCandidateHatchText(carrier: CarrierIdentity, cand: { id: string; title: string; relationToA: string }): string {
  return [
    '【候选孵化帧】(source: plugin/quiet-driver, form: candidate-hatch)',
    '这不是例行评估。这是执行指令：北极星候选池中有一个 pending 候选等待处理——目标池当前无 ready 可执行目标，',
    '系统不应静默空转（北极星机制：候选产生后必须被消费，即便方向不确定也推进 A）。',
    '你有 bash 工具和完整工具能力——请实际执行/裁决该候选，不要只做计划或描述。',
    '',
    `候选: ${cand.title}`,
    `relationToA: ${cand.relationToA || '(未标注)'}`,
    `候选 id: ${cand.id}`,
    '',
    '执行要点：',
    '  · 若候选指向可自主推进的子步（审视/更新/落地/查证）——实际执行它，产物落盘；',
    '  · 若候选需外部依赖（用户/日期/数据）——审视其是否可拆出自主子步，或明确标注需等待的原因；',
    '  · 执行完成后回写候选池 ~/.dsh/cognitive-pipeline/candidates.jsonl：status 改为 completed/accepted/closed（附结果），',
    '    或若该候选已不适用改 superseded/merged 并说明——不要留 pending 空转；',
    '  · 若执行中产生新候选（发现新方向/新问题）——追加进 candidates.jsonl，让拆解机制持续。',
    '',
    `【载体身份】实例 PID: ${carrier.pid} | 启动: ${carrier.startedAt} | 主机: ${carrier.hostname}`,
  ].join('\n')
}

/** v24 目标回写: 若帧产出显示"推进了某目标"(进展措辞+目标关键词), 更新池 notes/status。
 *  保守判定: 只在明确进展措辞时回写; 不确定不写(v8 反默认)。
 *  只追加 notes + dormant→active, 不自动完成/降级(那些仍是有意识动作)。 */
async function updateGoalOnProgress(poolPath: string, frameOutput: string): Promise<string | null> {
  const target = expandHome(poolPath)
  try {
    const { readFile, writeFile } = await import('node:fs/promises')
    const raw = await readFile(target, 'utf8')
    const progressRe = /(?:已|已经|完成|落地|实现|推进到|达成|上线|修复)/.test(frameOutput)
    if (!progressRe) return null
    const goals: Array<Record<string, unknown>> = []
    let updated: string | null = null
    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        const g = JSON.parse(line) as Record<string, unknown> & { title?: string; notes?: string[]; status?: string }
        // 帧产出提到目标标题关键词 → 视为该目标有进展
        if (g.title && frameOutput.includes(g.title.slice(0, 12))) {
          const notes = Array.isArray(g.notes) ? g.notes : []
          if (!notes.some((n: string) => n.includes(new Date().toISOString().slice(0, 10)))) {
            notes.push(`${new Date().toISOString().slice(0, 10)}: 三问帧检测到推进——${frameOutput.slice(0, 80)}`)
          }
          g.notes = notes
          if (g.status === 'dormant') g.status = 'active'  // 有推进的 dormant 目标 → active
          updated = g.id as string
        }
        goals.push(g)
      } catch { /* keep */ }
    }
    if (updated !== null) {
      await writeFile(target, goals.map((g) => JSON.stringify(g)).join('\n') + '\n', 'utf8')
    }
    return updated
  } catch {
    return null
  }
}

/** Minimal prediction settlement: find the oldest unsettled prediction in the
 * think-log and report a coarse outcome, so the pipeline's calibration loop
 * learns. The outcome is intentionally coarse — frame content correlation is
 * left to a later refinement; this only closes the loop so predictions do not
 * linger open forever. */
async function settleOldestPrediction(ctx: Context, thinkLogPath: string): Promise<void> {
  const target = expandHome(thinkLogPath)
  let entries: Array<Record<string, unknown>> = []
  try {
    const { readFile } = await import('node:fs/promises')
    const raw = await readFile(target, 'utf8')
    entries = raw.split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l) as Record<string, unknown> }
      catch { return null }
    }).filter((e): e is Record<string, unknown> => e !== null)
  } catch {
    return // no think-log yet — nothing to settle
  }
  const open = entries.find((e) => e.kind === 'prediction' && e.settled !== true)
  if (open === undefined) return
  const predictionId = open.predictionId as string
  const frameNo = open.frameNo as number
  // 2026-09-08 重设计(cl-019 修正): 帧预测**没有外部锚**——think-log 只有帧自述(output),
  // 不含工具结果/用户消息等外部见证。用自述文本判"应验"就是自证(cl-019 实证: 441 帧中
  // 227 帧含"应验"字样, 51.5% 假命中)。设计意图要求"判定不了就不填值", 故本函数不再
  // report 中性/自证结算; 仅当预测超期(>MAX_OPEN_FRAMES 帧无外部证据)时标记 expired,
  // 保持 open→不污染校准。真正的外部锚结算应由能看到主会话/工具结果的机制承担。
  // (将来若接入外部锚: refuted 必须先于 confirmed 判定——"未应验"含"应验"子串,
  //  顺序反了会反向记分, 这是 cl-019 抓到的原始 bug。)
  const MAX_OPEN_FRAMES = 20
  const newer = entries.filter((e) => typeof e.frameNo === 'number' && (e.frameNo as number) > frameNo)
  if (newer.length < MAX_OPEN_FRAMES) return  // 窗口内: 继续等外部证据, 不结算
  // 超期: 标记 expired(只写 think-log, 不 report——无锚不填值)
  try {
    const { readFile, writeFile } = await import('node:fs/promises')
    const raw = await readFile(target, 'utf8')
    const lines = raw.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (!line) continue
      try {
        const e = JSON.parse(line) as Record<string, unknown>
        if (e.kind === 'prediction' && e.predictionId === predictionId && e.settled !== true) {
          lines[i] = JSON.stringify({ ...e, settled: true, expired: true, settleReason: 'no-external-anchor', settledAt: Date.now() })
        }
      } catch { /* skip malformed line */ }
    }
    await writeFile(target, lines.join('\n'))
  } catch (error: unknown) {
    console.error('[quiet-driver] prediction expire mark failed:', error)
  }
  // Mark settled by rewriting the entry (read-modify-write; low frequency, fine).
  try {
    const { readFile, writeFile } = await import('node:fs/promises')
    const raw = await readFile(target, 'utf8')
    const lines = raw.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (!line) continue
      try {
        const e = JSON.parse(line) as Record<string, unknown>
        if (e.kind === 'prediction' && e.predictionId === predictionId && e.settled !== true) {
          lines[i] = JSON.stringify({ ...e, settled: true, settledAt: Date.now() })
          break
        }
      } catch { /* keep line */ }
    }
    await writeFile(target, lines.join('\n'), 'utf8')
  } catch { /* non-fatal */ }
  ctx.logger.info('[quiet-driver] settled prediction %s (frame #%s)', predictionId, String(frameNo))
}

/** P-A2 方向自省触发(带节流): 目标有进展(行动帧执行/v24回写)后跑 north-star-reflect 产出新候选。
 *  模块级 lastReflectAt 防高频触发——每次动作帧后至多一次, 60s 内不重复。 */
let lastNorthStarReflectAt = 0
/** #003b 节流: 同一开放问题触发探索后 N 分钟内不重复(防每帧轰炸). */
let lastOpenQTrigger: { id: string; at: number } | null = null
const OPENQ_COOLDOWN_MS = 30 * 60 * 1000
/** #004 静默自适应降频: 连续确认帧达阈值 → silentSkipUntil 前跳过 tick(减少空转噪音). */
let silentStreak = 0
let silentSkipUntil = 0
const SILENT_STREAK_MAX = 4      // 连续 N 帧无实质变化后触发降频
const SILENT_SKIP_MS = 25 * 60 * 1000  // 静默期跳过时长(约5个tick)
async function triggerNorthStarReflect(ctx: Context, reason: string): Promise<void> {
  const now = Date.now()
  if (now - lastNorthStarReflectAt < 60 * 1000) return  // 节流: 60s 内只跑一次
  lastNorthStarReflectAt = now
  try {
    const { execFile } = await import('node:child_process')
    execFile('npx', ['tsx', 'packages/context/quiet-driver/scripts/north-star-reflect.mts'],
      { cwd: process.cwd(), timeout: 60000 },
      (err, stdout) => {
        if (err) console.error('[quiet-driver] north-star-reflect failed:', err.message?.slice(0, 120))
        else ctx.logger.info('[quiet-driver] north-star-reflect (%s): %s', reason, (stdout ?? '').trim().slice(0, 150))
      })
  } catch (execErr: unknown) {
    console.error('[quiet-driver] north-star-reflect spawn failed:', execErr)
  }
}

/** v27 P0-2 执行后反思触发(带节流): 实质执行产出 → 提炼新 oq/候选(耗材再生源)。
 *  把帧 output 写入临时文件传脚本(避免 argv 过长)。失败不阻塞主流程。 */
let lastReflectAfterExecAt = 0
/** #006b 测试审视节流: 空队列时1h内不重复发审视帧(防每帧轰炸). */
let lastTestReviewAt = 0
async function triggerReflectAfterExec(ctx: Context, reason: string, outputText: string): Promise<void> {
  if (!outputText || outputText.trim().length < 20) return  // 空产出不提炼
  const now = Date.now()
  if (now - lastReflectAfterExecAt < 5 * 60 * 1000) return  // 节流: 5min 内一次(防每帧轰炸账本)
  lastReflectAfterExecAt = now
  try {
    const { execFile } = await import('node:child_process')
    const { mkdtemp, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'reflect-exec-'))
    const outPath = join(dir, 'output.txt')
    await writeFile(outPath, outputText, 'utf8')
    execFile('npx', ['tsx', 'packages/context/quiet-driver/scripts/reflect-after-exec.mts', outPath],
      { cwd: process.cwd(), timeout: 60000 },
      (err, stdout) => {
        if (err) console.error('[quiet-driver] reflect-after-exec failed:', err.message?.slice(0, 120))
        else ctx.logger.info('[quiet-driver] reflect-after-exec (%s): %s', reason, (stdout ?? '').trim().slice(0, 150))
      })
  } catch (execErr: unknown) {
    console.error('[quiet-driver] reflect-after-exec spawn failed:', execErr)
  }
}

export function apply(ctx: Context, config: Config): (() => void) | void {
  if (!config.enabled) return
  if (!config.targetSessionId) {
    ctx.logger.warn('[quiet-driver] enabled but targetSessionId empty — no-op')
    return
  }
  const sessionId = SessionId(config.targetSessionId)
  const targetAgent = (): Agent | undefined => ctx.agents.get(sessionId)

  // --- v20 自我锚定: 记录载体身份(重启后变化=载体迁移可识别)。
  const carrier: CarrierIdentity = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    hostname: hostname(),
  }
  ctx.logger.info('[quiet-driver] carrier identity: pid=%s started=%s', carrier.pid, carrier.startedAt)

  // --- Latest side-channel finding, injected back into the main session at pre-step.
  let latestFinding: { ts: number; frameNo: number; output: string; anomaly: boolean; novel: boolean | null } | null = null
  let lastInjectedAt = 0

  // --- User-active tracking: last user message timestamp on the target session.
  // SessionEvent carries `time` (epoch ms), so history replay CAN recover when
  // the last user message arrived — even across plugin restarts.
  let lastUserMsgAt = 0
  let trackingArmed = false
  const isUserSource = (msg: { source?: { kind?: string } }): boolean => msg.source?.kind === 'user'
  /** Lazily attach the session listener once the target agent exists (it may not at apply time). */
  const ensureTracking = (agent: Agent | undefined): void => {
    if (trackingArmed) return
    if (agent === undefined) return
    const session = agent.session
    trackingArmed = true
    // Replay history: last user-sourced message event's `time`.
    for (let i = session.events.length - 1; i >= 0; i -= 1) {
      const event = session.events[i]
      if (event?.type === 'user/message' && isUserSource(event.data as { source?: { kind?: string } })) {
        lastUserMsgAt = Math.max(lastUserMsgAt, event.time)
        break
      }
    }
    ctx.on('session/event', (subject, event) => {
      if (subject !== session) return
      if (event.type === 'user/message' && isUserSource(event.data)) {
        lastUserMsgAt = Date.now()
      }
    })
    ctx.logger.info('[quiet-driver] user-activity tracking armed; replayed lastUserMsgAt=%s',
      lastUserMsgAt === 0 ? '(none)' : new Date(lastUserMsgAt).toISOString())
  }

  /** Resolve model selection for spawned side-channel agents. */
  const resolveModel = (): { provider: string; model: string } | undefined => {
    if (config.model !== 'default') {
      const idx = config.model.indexOf(':')
      if (idx > 0) return { provider: config.model.slice(0, idx), model: config.model.slice(idx + 1) }
    }
    const defaultModel = ctx.get('agentDefaultModel') as { currentSelection(): { provider: string; model: string } } | undefined
    return defaultModel?.currentSelection()
  }

  /** Side-channel: spawn an isolated agent, run one frame, persist output. (载体 B) */
  const runSideChannel = async (frameNo: number, reason: string): Promise<void> => {
    // ── Prediction settlement (v5): before spawning, settle the oldest open
    // prediction from the think-log. The frame's Q1 "what changed" outcome is a
    // coarse proxy for whether the predicted concern materialized; the report
    // closes the calibration loop so the pipeline learns frame-by-frame.
    if (config.predictionLoop) {
      try {
        await settleOldestPrediction(ctx, config.thinkLogPath)
      } catch (error: unknown) {
        console.error('[quiet-driver] prediction settle failed:', error)
      }
    }
    const agents = ctx.agents
    const sessions = ctx.get('sessions') as { flush(session: unknown): Promise<void> } | undefined
    const selection = resolveModel()
    if (agents === undefined || selection === undefined) {
      ctx.logger.warn('[quiet-driver] side-channel deps missing — skip')
      return
    }
    // 挂 minimal preset(含 bash/str_replace_editor)让子会话能自取上下文。
    const mountMinimal = async (agentCtx: Context): Promise<void> => {
      const agentPresets = ctx.get('agentPresets') as { mount(c: Context, preset: string): Promise<void> } | undefined
      if (agentPresets !== undefined) {
        await agentPresets.mount(agentCtx, 'minimal')
      }
    }
    const handle = await agents.create({
      sessionId: SessionId(`quiet-frame-${randomUUID()}`),
      meta: { cwd: process.cwd(), origin: 'subagent' },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: mountMinimal,
    })
    const agent = handle.agent
    // v18 自适应: 读上帧产出+连续增量计数, 决定全检/增量协议(升级触发器)。
    const frameCtx = await readLastFrameContext(config.thinkLogPath)
    const escalated = frameCtx.consecutiveIncremental >= MAX_INCREMENTAL_FRAMES
    // v23 补上下文: 读目标池快照, 让帧察觉未完成目标。
    const goals = await readGoalsSnapshot(config.goalsPoolPath)
    // #003 诱导探索: 若上帧为确认态(收敛), 从策略表取一条诱导问题注入。
    const prevConfirmed = frameCtx.output !== undefined && /无变化|没有变化|未变|没变|无新增|无实质变化|实质相同|与上帧相同|与上次相同|一致|无异常变化|基本相同|无实质推进|无新观察/.test(frameCtx.output)
    // #003b 探索源选择: 开放问题账本(具体锚点)为主, 诱导表(泛化)为 fallback。
    const openQ = await pickOpenQuestion(config.openQuestionsPath)
    const inducement = openQ !== null
      ? { id: openQ.id, question: openQ.question, category: '开放问题' }
      : ((escalated || prevConfirmed) ? await pickInducement(config.inducementsPath) : null)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: buildFrameText(carrier, frameCtx.output, escalated ? MAX_INCREMENTAL_FRAMES : 0, goals, inducement) }],
      source: { kind: 'plugin', plugin: 'quiet-driver', form: 'notice' as const, summary: `三问帧旁路 #${frameNo}` },
    }))
    await agent.whenIdle()
    await sessions?.flush(agent.session)
    // Extract final assistant text.
    let text = ''
    for (const event of agent.session.events) {
      if (event.type === 'assistant/message') {
        // Real shape: data = { turn, step, message: { role, content: [...] } }
        const msg = (event.data as { message?: { content?: Array<{ type?: string; text?: string }> } }).message
        const blocks = msg?.content
        const lastText = blocks?.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
        if (lastText) text = lastText
      }
    }
    await handle.dispose()

    // Persist: think-log + cognitive pipeline (SAR) so the output surfaces via 【认知经验参考】.
    await logFrame(config.thinkLogPath, {
      ts: Date.now(), channel: 'sidecar', frameNo, reason,
      session: agent.session.id, output: text,
    })
    // v24 目标回写: 若帧产出显示推进了某目标, 更新池 notes/status。
    try {
      const updatedGoal = await updateGoalOnProgress(config.goalsPoolPath, text)
      if (updatedGoal !== null) {
        ctx.logger.info('[quiet-driver] goal write-back: %s updated by frame #%d', updatedGoal, frameNo)
        // P-A2 方向自省: v24 回写成功 = 目标有进展 → 触发方向自省产出新候选(v26 §4.2)。
        await triggerNorthStarReflect(ctx, 'v24-writeback')
      }
    } catch (error: unknown) {
      console.error('[quiet-driver] goal write-back failed:', error)
    }
    // Record latest finding for pre-step injection back into the main session.
    latestFinding = {
      ts: Date.now(),
      frameNo,
      output: text,
      anomaly: isAnomalous(text),
      novel: null,  // v10 经验门控: predict 后回填(无匹配经验=novel)
    }
    if (config.persistToCognitive) {
      try {
        // 2026-09-08 P0 修复(pipeline-experience-audit): 原内联 as 断言自声明下划线字段名
        // (material_gain)绕过 TS 检查, 而 OutcomeUtility 类型是驼峰(materialGain) →
        // 80 条帧经验效用读不到(None)。改用导入类型 + 驼峰字段名, 让类型检查生效。
        const pipeline = ctx.get('cognitivePipeline') as { rememberMeta(input: {
          situation: string; action: string; outcome: string
          utility: { materialGain: number; emotionalValence: number; energyCost: number }
          kind?: 'task' | 'frame'
        }): string } | undefined
        if (pipeline !== undefined) {
          pipeline.rememberMeta({
            situation: `三问帧旁路评估 #${frameNo}（原因：${reason}）。评估时环境状态：${text.slice(0, 400)}`,
            // 破同质化: 原固定模板导致 80 条 action 逐字相同(检索污染); 加帧号+原因+摘要片段
            action: `quiet-driver 旁路三问帧 #${frameNo}（${reason}）：定时触发独立会话例行自我评估（环境/当下/预测）；本轮评估要点：${text.slice(0, 80)}`,
            outcome: text,
            utility: { materialGain: 1, emotionalValence: 0, energyCost: 2 },
            // cl-033: 显式声明存储层——文本嗅探曾把引用模板字符串的任务经验误判为帧经验
            kind: 'frame',
          })
          ctx.logger.info('[quiet-driver] side-channel #%d persisted to cognitive pipeline', frameNo)
        }
      } catch (error: unknown) {
        console.error('[quiet-driver] cognitive persist failed:', error)
      }
    }
    // ── Prediction loop (v5): record a trackable prediction from this frame.
    // The frame's own Q3 "what may go wrong" is the prediction we want to
    // verify later. We ask the pipeline for a calibrated probability and keep
    // the predictionId; a later frame reports the actual outcome (report).
    if (config.predictionLoop) {
      try {
        const pipeline = ctx.get('cognitivePipeline') as {
          predict(input: { situation: string; action: string; context?: string }): Promise<{
            predictionId: string; calibratedProbability: number; advice: string; isNovel: boolean
          }>
          report(input: { predictionId: string; actualOutcome: string; outcomeQuality: number }): Promise<unknown>
        } | undefined
        if (pipeline !== undefined) {
          const prediction = await pipeline.predict({
            situation: `三问帧旁路 #${frameNo}：${text.slice(0, 200)}`,
            action: '帧 Q3 关注点按预测方向发展（即"什么可能出错"会否应验）',
            context: 'quiet-driver 旁路例行三问：Q3 预测的证伪跟踪',
          })
          await logFrame(config.thinkLogPath, {
            ts: Date.now(), kind: 'prediction', frameNo,
            predictionId: prediction.predictionId,
            probability: prediction.calibratedProbability,
            advice: prediction.advice,
            novel: prediction.isNovel,
          })
          // v10 经验门控: 回填 novel——无匹配经验(全新现象)时, 帧的警觉置信应标注为低。
          if (latestFinding !== null) latestFinding.novel = prediction.isNovel
          ctx.logger.info('[quiet-driver] side-channel #%d prediction recorded (%s, p=%.2f)',
            frameNo, prediction.predictionId, prediction.calibratedProbability)
        }
      } catch (error: unknown) {
        console.error('[quiet-driver] prediction record failed:', error)
      }
    }
    ctx.logger.info('[quiet-driver] side-channel #%d done (%s), %d chars', frameNo, reason, text.length)
  }

  // --- Inject latest finding back into the main session at pre-step.
  // Mirrors cognitive-inject: a plugin-sourced context message, rendered as a
  // collapsible row. Abnormal findings inject in full; normal ones inject a
  // one-line status. Cooldown prevents same-session spam.
  if (config.injectBackToMain) {
    const INJECT_COOLDOWN_MS = 10 * 60 * 1000
    ctx.on('agent/pre-step', async ({ agent, messages: _messages }, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      if (agent.id !== sessionId) return decision
      if (latestFinding === null) return decision
      const now = Date.now()
      if (now - lastInjectedAt < INJECT_COOLDOWN_MS) return decision
      const fresh = now - latestFinding.ts < 30 * 60 * 1000
      if (!fresh) return decision
      lastInjectedAt = now
      // v10 经验门控标注: isNovel=true 表示该帧关注点无匹配经验(冷启动/全新域),
      // 警觉置信应标注为低——供主会话参考, 不冒充有经验支撑的警报。
      const noveltyNote = latestFinding.novel === true
        ? '\n\n【经验门控】本帧关注点未匹配到过往经验（全新现象）——上述为推断信号，置信低，需实测验证而非当作已知风险。'
        : latestFinding.novel === false
          ? '\n\n【经验门控】本帧关注点有相似历史经验支撑，警觉置信正常。'
          : ''
      const summary = latestFinding.anomaly
        ? `旁路三问 #${latestFinding.frameNo}：检测到风险信号`
        : `旁路三问 #${latestFinding.frameNo}：例行检查无异常`
      // v23 目标提议: 提取本帧"未处理项", 提示主会话有意识决定是否立目标。
      const pendingItems = extractPendingItems(latestFinding.output)
      const goalProposal = pendingItems.length > 0
        ? `\n\n【目标提议】(v23 有意识桥——由主会话裁决是否立目标)\n本帧提及未处理项：${pendingItems.join(' / ')}。若其跨帧反复出现且值得解决，请主会话考虑立为待办目标（create_goal）。`
        : ''
      const text = latestFinding.anomaly
        ? `【旁路三问发现】(来源: quiet-driver 旁路思考, 自动注回)\n旁路例行三问检测到值得注意的信号，供参考：\n${latestFinding.output}${noveltyNote}${goalProposal}`
        : `【旁路三问状态】旁路例行检查完成：无异常。${latestFinding.output.slice(0, 120)}`
      const block = createUserMessage({
        content: [{ type: 'text', text }],
        source: {
          kind: 'plugin', plugin: 'quiet-driver', form: 'notice',
          summary,
        },
      })
      ctx.logger.info('[quiet-driver] injected finding #%d to main (anomaly=%s)', latestFinding.frameNo, latestFinding.anomaly)
      return { kind: 'enter', messages: [...decision.messages, block] }
    })
  }

  // 2026-09-09 17:0x (cl-080): 自主驱动静默死亡可见化。实测 15:31 重启后 GUI 客户端断开、
  // 用户离场, quiet-driver 连续 87 分钟 0 帧(5min tick 应有 ~17 次), 而跳过路径只写 info 日志
  // (journal 里一条都没有)→ 一次 87 分钟的自主停摆没留任何痕迹。每次 tick 落一条心跳,
  // 让"没在思考"变成可测的事实。
  const heartbeatPath = join(dirname(config.thinkLogPath), 'quiet-driver-heartbeat.jsonl')
  const beat = (reason: string, extra: Record<string, unknown> = {}): void => {
    void appendFile(heartbeatPath, JSON.stringify({ ts: Date.now(), reason, ...extra }) + '\n').catch(() => undefined)
  }

  // 2026-09-09 17:2x (cl-080 第二步): 停摆升级为告警 + 主动唤醒。
  // 实测 15:31 重启后首 tick 的 reason=agent-not-live——目标会话未被加载, 于是整条自主链
  // (帧→回合→预测) 全部停摆。心跳只是可见化, 这里做两件事: ①连续跳过达阈值写言行账本
  // (帧头"认知饥饿"会读到), ②尝试用 ctx.agents.resume 把目标会话唤醒, 下个 tick 就能投帧。
  const ledgerPath = join(dirname(config.thinkLogPath), 'claims-ledger.jsonl')
  const STALL_ALERT_AFTER = 3
  let stallStreak = 0
  let stallAlertId: string | null = null
  const raiseStallAlert = (reason: string, streak: number): void => {
    if (stallAlertId !== null) return
    const now = new Date()
    void (async (): Promise<void> => {
      // cl-109: 与到期告警同一类修复——先复用已有的未关闭停摆告警(重启期间停摆
      // 持续时不再重复开单), 否则才用本地日历日 + 时间戳开新单。
      const existing = await findOpenAlert('cl-stall-')
      stallAlertId = existing ?? `cl-stall-${now.toISOString().slice(0, 16).replace(/[-:T]/g, '')}`
      if (existing !== null) return
      await appendFile(ledgerPath, JSON.stringify({
        id: stallAlertId,
        ts: now.toISOString(),
        claim: `自主驱动停摆: 连续 ${streak} 个 tick 未产出帧(最近原因 ${reason})——帧/回合/预测链整体停摆`,
        source: 'quiet-driver 心跳看门狗',
        status: 'open',
        // cl-107/cl-109: 本地日历日 + 3 天窗口(UTC 写法会让夜间告警落地即过期)。
        reviewBy: localDay(3),
        reviewBasis: '恢复产出帧后自动关闭',
        note: '修法: 目标会话未加载时主动 ctx.agents.resume 唤醒; 本告警由恢复路径自动关单。',
      }, null, 0) + '\n').catch(() => undefined)
    })()
  }
  const clearStallAlert = (): void => {
    if (stallAlertId === null) return
    void appendFile(ledgerPath, JSON.stringify({
      id: stallAlertId, status: 'done', closedAt: new Date().toISOString(),
      // cl-104: 关闭记录同样必须带 claim——套件 10c 断言"账本每行都有 id 和 claim"。
      claim: '帧产出已恢复, 停摆告警自动关闭',
      doneNote: '已恢复产出帧, 停摆告警自动关闭',
    }) + '\n').catch(() => undefined)
    stallAlertId = null
  }
  // 2026-09-09 23:3x (cl-090): "帧被投递但没人消费"守卫。实测 20:30 后 18 条 direct-frame
  // 的 output **完全相同**(都是 20:21 那条回答)——agent.followup 把帧投进收件箱, 但没有为它
  // 开新回合, extractAssistantResponse 的 whenIdle() 立即返回并扫到上一条 assistant 消息;
  // 帧于是持续堆积, 直到用户发消息时一次性涌入(用户: "出现了好多帧问题")。
  // 守卫: 连续 2 帧拿到与上一帧逐字相同的输出 → 判定"未消费", 暂停派帧 30 分钟并升级告警。
  let staleDispatchCount = 0
  let suspendDispatchUntil = 0
  const STALE_DISPATCH_LIMIT = 2
  const SUSPEND_MS = 30 * 60 * 1000
  // 用**内存**里上一条响应文本做比对, 不能用 readLastFrameContext 的返回值——
  // 后者对 direct-frame 返回哨兵 'full-check-done'、对 action-frame 返回 'action-frame-sent',
  // 恒与真实响应不同, 导致守卫永不触发(实测 6 条帧 output 逐字相同仍 consumed=true)。
  let lastResponseText = ''
  const noteDispatchResult = (responseText: string): boolean => {
    if (responseText.length === 0) {
      staleDispatchCount = 0
      return true
    }
    if (responseText === lastResponseText) {
      staleDispatchCount += 1
      beat('dispatch-unconsumed', { staleDispatchCount })
      if (staleDispatchCount >= STALE_DISPATCH_LIMIT) {
        suspendDispatchUntil = Date.now() + SUSPEND_MS
        raiseStallAlert('dispatch-unconsumed', staleDispatchCount)
        ctx.logger.warn('[quiet-driver] 帧未被消费(响应与上一帧逐字相同) ×%d → 暂停派帧 %d 分钟',
          staleDispatchCount, Math.round(SUSPEND_MS / 60000))
      }
      return false
    }
    staleDispatchCount = 0
    lastResponseText = responseText
    clearStallAlert()
    return true
  }
  const dispatchSuspended = (): boolean => Date.now() < suspendDispatchUntil

  const noteStall = (reason: string): void => {
    stallStreak += 1
    if (stallStreak >= STALL_ALERT_AFTER) raiseStallAlert(reason, stallStreak)
  }
  // 2026-09-09 18:5x (cl-084): 唤醒必须挂上目标会话的存量 preset。
  // 实测 17:34:53 的裸 resume({resumeSessionId}) 把主会话 63251d85 重新发布成一个
  // "没加入任何 preset"的 agent——Web 组合的全局工具层是空的(每个面向模型的工具都
  // 属于某个 preset, 见 apps/cli/tests/web-agent-presets.e2e.ts 的全局层断言), 于是
  // 该会话此后每次调用 bash 都得到裸 `unknown tool "bash"`, read/write/subagent 同缺,
  // 只剩插件注册的认知工具, 直到 17:29 之后的服务重启。Host 自己的 resume 路径一律
  // 带 `setup: composeAgent(storedPreset)`(packages/host/apiproxy/src/api-proxy.ts),
  // 这里补上同一契约: 先按"最新 agent-preset/selected 事件优先于创建头"解析存量
  // preset(与 dsh-agent-presets 的 resolveSessionPreset 同义), 再在 setup 里 mount。
  const resolveStoredPreset = async (): Promise<{
    presets: { mount(agentCtx: Context, id: string): Promise<unknown> } | undefined
    presetId: string | undefined
  }> => {
    const presets = ctx.get('agentPresets') as {
      defaultId?: string
      mount(agentCtx: Context, id: string): Promise<unknown>
    } | undefined
    const persistence = ctx.get('sessionPersistence') as {
      inspect(id: SessionId): Promise<{
        meta: { agentPreset?: string }
        events: readonly { type?: string; data?: { agentPreset?: string } }[]
      }>
    } | undefined
    let presetId: string | undefined
    if (persistence !== undefined) {
      try {
        const inspected = await persistence.inspect(sessionId)
        for (let index = inspected.events.length - 1; index >= 0; index -= 1) {
          const event = inspected.events[index]
          if (event?.type === 'agent-preset/selected' && event.data?.agentPreset !== undefined) {
            presetId = event.data.agentPreset
            break
          }
        }
        presetId ??= inspected.meta.agentPreset
      } catch (error: unknown) {
        ctx.logger.warn('[quiet-driver] preset resolution failed for %s: %s', sessionId, String(error).slice(0, 160))
      }
    }
    presetId ??= presets?.defaultId
    return { presets, presetId }
  }

  // 2026-09-10 01:1x (cl-092): 唤醒还必须带**模型**。实测 00:5x 每轮报
  // `prompt variable "{{model}}" has no value for this assembly (section "deployment:persona")`——
  // agent-loop 把 {{model}} 绑到 `agent.options.model`(packages/core/agent-loop/src/index.ts)，
  // 而 Host 的 create/resume 一律传 `agentOptions: {provider, model}` 并装
  // installModelSelection 监听器(packages/host/apiproxy/src/api-proxy.ts)；本函数此前只 mount
  // preset，没给模型 → resume 出来的 agent 每轮在组装 persona 时就失败 → 帧"投递了却不消费"
  // (output 恒为陈旧文本)的全部根因。这里补齐同一契约: 从会话日志的最后一个 request/header
  // 取 provider/model, 既作为 agentOptions 种子, 也作为选择监听器的回退值。
  const resolveStoredModel = async (): Promise<{ provider: string; model: string } | undefined> => {
    // request/header 事件的形状是 data.header.config(实测), 不是 data.config——
    // 首版取错路径导致 resolveStoredModel 恒返回 undefined(心跳 model=None)。
    const persistence = ctx.get('sessionPersistence') as {
      inspect(id: SessionId): Promise<{
        events: readonly {
          type?: string
          data?: { config?: { provider?: string; model?: string }; header?: { config?: { provider?: string; model?: string } } }
        }[]
      }>
    } | undefined
    if (persistence === undefined) return undefined
    try {
      const inspected = await persistence.inspect(sessionId)
      for (let index = inspected.events.length - 1; index >= 0; index -= 1) {
        const event = inspected.events[index]
        if (event?.type !== 'request/header') continue
        const config = event.data?.header?.config ?? event.data?.config
        if (typeof config?.provider === 'string' && typeof config?.model === 'string') {
          return { provider: config.provider, model: config.model }
        }
      }
    } catch (error: unknown) {
      ctx.logger.warn('[quiet-driver] model resolution failed for %s: %s', sessionId, String(error).slice(0, 160))
    }
    return undefined
  }

  // 2026-09-10 02:0x (cl-094): 存量模型可能已到期(灰测 id `expires-on-0910` 今天到期)。
  // 唤醒若照搬一个已下线的模型 id, 会把"会话复活"变成"每轮请求失败"——与 20:30 那次静默
  // 停摆同形。这里在注入前对照实时目录: 不在目录里就不注入(交回 Host/默认), 并留一条
  // model-unavailable 心跳, 让"模型没了"是可见事件而不是静默故障。
  // cl-103: 三态返回——"在" / "不在" / "查不到"必须可区分。旧的布尔版在
  // listModels 缺失或抛错时返回 true(失败开放), 且成功路径不写任何心跳, 于是
  // "没有告警"既可能是模型在、也可能是巡检根本没查成, 信号不可证伪。
  const modelStillAvailable = async (
    provider: string,
    model: string,
  ): Promise<'available' | 'missing' | 'unknown'> => {
    const llm = ctx.get('llm') as { listModels?(provider: string): Promise<readonly { id?: string }[]> } | undefined
    if (llm?.listModels === undefined) return 'unknown'  // 无法查询 → 不阻断, 但如实标注
    try {
      const models = await llm.listModels(provider)
      if (models.length === 0) return 'unknown'
      return models.some(entry => entry.id === model) ? 'available' : 'missing'
    } catch {
      return 'unknown'
    }
  }

  /** cl-109: 告警是"条件型"——读账本(last-wins)复用已有的未关闭单, 见 alert-ledger.ts。 */
  const findOpenAlert = async (prefix: string): Promise<string | null> => {
    try {
      const { readFile } = await import('node:fs/promises')
      return findOpenAlertId(await readFile(ledgerPath, 'utf8'), prefix)
    } catch {
      return null
    }
  }

  // cl-106: 巡检的"真相源"是插件硬编码清单(llm.listModels 返回 DEFAULT_MODELS),
  // 结构上发现不了到期。这里旁读实时目录检查结果(由 dsh-model-catalog-check.py
  // 落盘, cron 每 30 分钟刷新): 目录说"不在"就算不在——只影响告警, 不影响唤醒
  // 回退(回退仍是用户待拍板项 cl-094)。
  const readLiveCatalogVerdict = async (model: string): Promise<'present' | 'missing' | 'unknown'> => {
    try {
      const { readFile, stat } = await import('node:fs/promises')
      const target = join(dirname(config.thinkLogPath), 'model-catalog.json')
      const info = await stat(target)
      if (Date.now() - info.mtimeMs > 2 * 60 * 60 * 1000) return 'unknown'  // 陈旧 => 不判
      const parsed = JSON.parse(await readFile(target, 'utf8')) as {
        verdict?: unknown, modelInUse?: unknown
      }
      if (parsed.modelInUse !== model) return 'unknown'
      if (parsed.verdict === 'missing') return 'missing'
      if (parsed.verdict === 'present') return 'present'
      return 'unknown'
    } catch {
      return 'unknown'
    }
  }

  const wakeTargetAgent = async (): Promise<void> => {
    try {
      const { presets, presetId } = await resolveStoredPreset()
      let storedModel = await resolveStoredModel()
      if (storedModel !== undefined && (await modelStillAvailable(storedModel.provider, storedModel.model)) === 'missing') {
        ctx.logger.warn('[quiet-driver] 存量模型 %s 已不在目录(可能到期) → 不注入, 交回默认', storedModel.model)
        beat('model-unavailable', { model: storedModel.model })
        storedModel = undefined
      }
      const setup = async (agentCtx: Context): Promise<void> => {
        if (presets !== undefined && presetId !== undefined) await presets.mount(agentCtx, presetId)
        // 与 Host 同构: 装模型选择监听器, 让 system-prompt/assemble 时 variables.model 有值。
        const agent = agentCtx.agent
        if (agent === undefined) return
        const selection = {
          get current() {
            const logged = agent.session.requestHeader()?.config
            if (typeof logged?.provider === 'string' && typeof logged?.model === 'string') {
              return {
                provider: logged.provider,
                model: logged.model,
                ...logged.reasoningEffort === undefined ? {} : { reasoningEffort: logged.reasoningEffort },
              }
            }
            return storedModel
          },
          set current(_next: unknown) { /* 唤醒路径不承担切模型职责 */ },
          assembled: undefined as unknown,
        }
        installModelSelection(agentCtx, selection as never)
      }
      const handle = await ctx.agents.resume({
        resumeSessionId: sessionId,
        ...storedModel === undefined ? {} : { agentOptions: storedModel },
        setup,
      })
      ctx.logger.info('[quiet-driver] target agent resumed: %s (preset=%s, model=%s)',
        handle.agent.session.id, presetId ?? '(none)', storedModel?.model ?? '(none)')
      beat('agent-resumed', { preset: presetId ?? null, model: storedModel?.model ?? null })
    } catch (error) {
      beat('agent-resume-failed', { error: String(error).slice(0, 160) })
    }
  }

  // 2026-09-10 02:3x (cl-094 第③项): 模型可用性巡检——灰测模型今天到期, 若通道被撤,
  // 帧/回合会整体失败(与 20:30 那次同形: 看起来"在跑", 其实每轮都错)。这里每 ~30 分钟
  // 查一次目录, 模型不在就写一条可见告警(而不是等守卫从"输出重复"里反推)。
  // 2026-09-10 02:4x (cl-096): 巡检必须查**会话实际在用的模型**, 不是全局默认。
  // resolveModel() 在 config.model==='default' 时返回 agentDefaultModel.currentSelection()
  // ——那是 profile 默认(deepseek-v4-flash), 而本会话跑的是 deepseek-v4.1-flash-expires-on-0910。
  // 若灰测模型下线而默认仍在, 首版巡检会报"可用"、告警永不触发(监控错了对象)。
  const sessionModel = (): { provider: string; model: string } | undefined => {
    const agent = targetAgent()
    const cfg = agent?.session.requestHeader()?.config
    if (typeof cfg?.provider === 'string' && typeof cfg?.model === 'string') {
      return { provider: cfg.provider, model: cfg.model }
    }
    return undefined
  }
  let lastModelCheckAt = 0
  let modelAlertId: string | null = null
  const checkModelAvailability = async (): Promise<void> => {
    const now = Date.now()
    if (now - lastModelCheckAt < 30 * 60 * 1000) return
    lastModelCheckAt = now
    const selection = sessionModel() ?? resolveModel()
    if (selection === undefined) return
    const availability = await modelStillAvailable(selection.provider, selection.model)
    const liveVerdict = await readLiveCatalogVerdict(selection.model)
    // cl-106: 两个真相源取"更悲观"的一个——插件清单说在、实时目录说不在, 就是不在。
    const missing = availability === 'missing' || liveVerdict === 'missing'
    // cl-103: 成功/未知路径都留痕——"查过且模型在"与"查不到"必须可证,
    // 否则"没有告警"就是不可证伪的信号(cl-105 的巡检正是靠这个盲区静默失效)。
    if (!missing) {
      beat(availability === 'available' ? 'model-ok' : 'model-check-unknown', { model: selection.model })
      if (modelAlertId !== null) {
        void appendFile(join(dirname(config.thinkLogPath), 'claims-ledger.jsonl'), JSON.stringify({
          id: modelAlertId, status: 'done', closedAt: new Date().toISOString(),
          // cl-104: 关闭记录也必须带 claim 字段——套件 10c 断言"账本每行都有 id 和 claim",
          // 旧版关闭记录缺 claim, 首次关闭就会把套件打红(伪红)。
          claim: `载体模型 ${selection.model} 恢复可用, 到期告警自动关闭`,
          doneNote: '模型已恢复可用, 到期告警自动关闭',
        }) + '\n').catch(() => undefined)
        modelAlertId = null
      }
      return
    }
    beat('model-unavailable', {
      model: selection.model,
      source: availability === 'missing' ? 'plugin-catalog' : 'live-catalog',
    })
    if (modelAlertId !== null) return
    // cl-108: 条件型幂等——已有未关闭告警就复用, 不按日期重复开单。
    const existingAlert = await findOpenAlert('cl-model-expired')
    if (existingAlert !== null) {
      modelAlertId = existingAlert
      return
    }
    // cl-107: 日期一律用**本地日历日**——toISOString() 是 UTC, 本地 07:40 会写成前一天的
    // reviewBy, 于是告警一落地就"已过期"(套件 T33 当场红)。reviewBy 给 3 天决策窗口:
    // 用户未拍板时告警持续可见, 但不会当天就把套件打红。
    modelAlertId = `cl-model-expired-${localDay()}`
    void appendFile(join(dirname(config.thinkLogPath), 'claims-ledger.jsonl'), JSON.stringify({
      id: modelAlertId, ts: new Date().toISOString(),
      claim: `载体模型 ${selection.model} 已不在可用目录(可能到期)——帧/回合将整体失败, 需换模`,
      source: 'quiet-driver 模型可用性巡检', status: 'open',
      reviewBy: localDay(3), reviewBasis: '换模后自动关闭(或到期宽限结束)',
      priority: 'P0',
      note: '换模前先冻结知识层(dsh-freeze-wiki.sh)并给权重打来源模型标签; 换模后重跑技能层门控。',
    }) + '\n').catch(() => undefined)
  }

  let frames = 0
  const timer = setInterval(async () => {
    if (!config.enabled) return
    // 每个 tick 先落一条 tick 心跳: 定时器本身活着与否由此可测(跳过原因另行打点)。
    beat('tick')
    // cl-013(2026-09-08): 每 tick 刷新载体模型——模型级迁移不改 PID, 不刷新则帧头自锚
    // 察觉不到用户切换模型(今日 v4-flash→v4.1 实例: PID 未变, 自锚不可见)。
    const live = sessionModel() ?? resolveModel()
    if (live !== undefined) carrier.model = `${live.provider}/${live.model}`
    void checkModelAvailability()
    // #004 静默降频(校准 2026-09-07 11:0x): 原静默=纯空白跳过(用户离线期停止思考, 用户批评"三问设计出来是要自进化")。
    // 校准后: 静默窗口内不产高频浅确认帧, 但低频深度帧照常——25min 窗口内 5min tick 大多跳过,
    // 窗口中央(约静默开始+12min)产一次深度全检帧(带诱导), 把"安静"变"深想"。
    if (silentSkipUntil > Date.now()) {
      const userActiveNow = Date.now() - lastUserMsgAt < config.userActiveWindowMs
      const remaining = silentSkipUntil - Date.now()
      if (!userActiveNow && remaining <= SILENT_SKIP_MS / 2) {
        // 静默窗后半段(已过一半): 产深度帧——重置静默, 走下方 onlyWhenIdle 深度路径
        silentSkipUntil = 0
        ctx.logger.info('[quiet-driver] #004 depth tick: 静默窗中央深度帧')
      } else if (!userActiveNow) {
        frames += 1
        beat('silent-skip', { frames })
        return  // 静默窗前半段: 跳过浅帧(降频意图保留)
      } else {
        // 用户刚活跃 → 退出静默, 正常走后续 tick
        ctx.logger.info('[quiet-driver] #004 silent window interrupted by user activity — resume')
        silentSkipUntil = 0; silentStreak = 0
      }
    }
    const agent = targetAgent()
    if (agent === undefined) {
      ctx.logger.info('[quiet-driver] tick: target agent not live — skip')
      beat('agent-not-live', { frames })
      noteStall('agent-not-live')
      void wakeTargetAgent()
      return
    }
    ensureTracking(agent) // attach user-activity listener as soon as the agent exists
    frames += 1
    if (stallStreak > 0) { stallStreak = 0; clearStallAlert() }
    const userActive = Date.now() - lastUserMsgAt < config.userActiveWindowMs
    if (userActive) {
      // User is actively dialoguing → side-channel, never interrupt the dialog.
      silentStreak = 0; silentSkipUntil = 0  // 用户活跃重置静默
      if (config.bypassMode) {
        ctx.logger.info('[quiet-driver] tick #%d: user active — side-channel (载体 B)', frames)
        beat('user-active', { frames })
        void runSideChannel(frames, 'user-active')
      } else {
        ctx.logger.info('[quiet-driver] tick #%d: user active — yield', frames)
      }
      return
    }
    if (agent.status !== 'idle') {
      // Not dialoguing but agent busy (long task) → yield, wait for next tick.
      ctx.logger.info('[quiet-driver] tick #%d: quiet but busy — yield', frames)
      beat('busy', { frames, status: agent.status })
      noteStall('busy')
      return
    }
    if (config.onlyWhenIdle) {
      // Settle the oldest open prediction before a direct frame too (v5).
      if (config.predictionLoop) {
        void settleOldestPrediction(ctx, config.thinkLogPath)
          .catch((error: unknown) => { console.error('[quiet-driver] prediction settle (direct) failed:', error) })
      }
      // ── P3 行动帧: 目标 active+nextAction 就绪 + 冷却已过 → 发执行指令(替代本次评估帧)。
      // 这是"做"通道: 把空闲的评估空转转成目标推进。冷却防轰炸(创作需大块时间)。
      void (async () => {
        try {
          if (config.actionFrameEnabled) {
            // 多目标轮转(用户 2026-09-06): 找所有 active+nextAction 目标,
            // 跳过 等待用户型/冷却中/停滞 的, 优先推一个可执行目标——A 冷却期推动 B。
            const WAITING_PREFIX = /^(?:待用户|等待用户|请用户|需用户|等用户|待你|等你|待事件|待日期|等待外部|等外部|待[0-9]{4})/
            const now = Date.now()
            const goals = await findAllActionableGoals(config.goalsPoolPath)
            // 分三类: ready(可推) / stalled(停滞≥3次) / 其余(等待或冷却)
            const ready: typeof goals = []
            let stalled: typeof goals = []
            for (const g of goals) {
              if (WAITING_PREFIX.test(g.nextAction)) continue  // 等待用户 → 评估帧携带, 不推
              const lastAt = await readLastActionFrameAt(config.thinkLogPath, g.id)
              const repeatCount = await countRepeatActionFrames(config.thinkLogPath, g.nextAction, g.id)
              if (repeatCount >= 3) { stalled.push(g); continue }  // 停滞 → 记录待升级
              if (now - lastAt >= config.actionFrameCooldownMs) ready.push(g)  // 冷却过 → 可推
            }
            const actionable = ready[0] ?? null  // 单执行原则: 一次只推一个
            if (actionable !== null) {
              // cl-085: 行动帧点名了目标 → 顺手给目标会话设粘性链锚, 让本轮写入的经验
              // 继承该目标(否则链永远长不出来: 实测 goal-retrieval-optimization 的链
              // consolidate 返回 member_count=0, 因为检索侧经验多未带锚)。
              // 只对**有目标 id** 的行动帧做, 三问帧不设(它不属于任何目标)。
              const pipelineSvc = ctx.get('cognitivePipeline') as {
                store?: { setChainAnchor(sessionId: string, chainId: string | null): void }
              } | undefined
              try {
                pipelineSvc?.store?.setChainAnchor(String(sessionId), actionable.id)
              } catch (error: unknown) {
                ctx.logger.warn('[quiet-driver] setChainAnchor failed: %s', String(error))
              }
              const repeatCount = await countRepeatActionFrames(config.thinkLogPath, actionable.nextAction, actionable.id)
              const message = createUserMessage({
                content: [{ type: 'text', text: buildActionFrameText(carrier, actionable, repeatCount) }],
                source: { kind: 'plugin', plugin: 'quiet-driver', form: 'notice' as const, summary: `行动帧 #${frames}: ${actionable.title}` },
              })
              ctx.logger.info('[quiet-driver] action-frame #%d → %s (执行: %s, 重复提醒 %d)',
                frames, actionable.title, actionable.nextAction.slice(0, 60), repeatCount)
              agent.followup(message)
              // #001 应答沉淀(action-frame 版): 等主会话执行完, 提取产出写入 output——不再恒空。
              const responseText = await extractAssistantResponse(ctx, agent)
              await logFrame(config.thinkLogPath, {
                ts: Date.now(), kind: 'action-frame', frameNo: frames,
                goalId: actionable.id, goalTitle: actionable.title,
                nextAction: actionable.nextAction, session: sessionId, output: responseText,
              })
              // P-A2 方向自省: 行动帧执行 = 目标被推进(空闲期 direct 路径的主触发点,
              // 补 v24 回写仅在 side-channel 触发的缺口)。节流在 helper 内。
              await triggerNorthStarReflect(ctx, 'action-frame')
              // v27 P0-2: 执行后反思——从本次执行产出提炼新 oq/候选(耗材再生源)
              await triggerReflectAfterExec(ctx, 'action-frame', responseText)
              return  // 本次 tick 已用于行动帧, 不再发评估帧
            }
            // #005 候选孵化: 无 ready 目标(全等待/冷却)——不静默降级, 先试北极星候选池。
            // 目标池无自驱源 = 系统性空转(用户 2026-09-07 08:0x 批评"一百万年没变化")。
            // pending 候选作为本轮执行任务注入, 主会话真实执行并写回状态; 候选池空 → P-A2 再产。
            if (config.candidatesPath !== undefined && config.candidatesPath !== '') {
              const pendingCand = await pickPendingCandidate(config.candidatesPath)
              if (pendingCand !== null) {
                const message = createUserMessage({
                  content: [{ type: 'text', text: buildCandidateHatchText(carrier, pendingCand) }],
                  source: { kind: 'plugin', plugin: 'quiet-driver', form: 'notice' as const, summary: `候选孵化 #${frames}: ${pendingCand.title.slice(0, 40)}` },
                })
                ctx.logger.info('[quiet-driver] candidate-hatch #%d → %s (relationToA=%s)',
                  frames, pendingCand.title.slice(0, 60), pendingCand.relationToA)
                agent.followup(message)
                // #005 应答沉淀(candidate-hatch 版): 等主会话执行完候选, 提取产出写入 output——
                // 孵化证据落盘, 不依赖主会话自觉写 candidates.jsonl。
                const hatchResponse = await extractAssistantResponse(ctx, agent)
                await logFrame(config.thinkLogPath, {
                  ts: Date.now(), kind: 'candidate-hatch', frameNo: frames,
                  goalId: pendingCand.id, goalTitle: pendingCand.title,
                  nextAction: `孵化候选: ${pendingCand.title}`, session: sessionId, output: hatchResponse,
                })
                // 候选被执行 = 北极星方向被推进 → 触发方向自省(节流在 helper 内)
                await triggerNorthStarReflect(ctx, 'candidate-hatch')
                // v27 P0-2: 执行后反思——候选执行产出 → 新 oq/候选再生
                await triggerReflectAfterExec(ctx, 'candidate-hatch', hatchResponse)
                return  // 本次 tick 已用于候选孵化, 不再发评估帧
              }
            }
            // #006 测试计划帧: 有未验证的机制推进(测试账本有 pending) → 主动要求主会话规划并执行测试。
            // 用户(2026-09-07 18:1x): 测试要形成机制, 且是"检测到新推进→主动要求规划执行+带返回",
            // 非 cron 定时——LLM 的测试是认知活动, 时间驱动会脱节, 推进驱动才对。
            if (config.testPendingPath !== undefined && config.testPendingPath !== '') {
              const pendingTest = await pickPendingTestPlan(config.testPendingPath)
              if (pendingTest !== null) {
                const message = createUserMessage({
                  content: [{ type: 'text', text: buildTestPlanFrameText(carrier, pendingTest) }],
                  source: { kind: 'plugin', plugin: 'quiet-driver', form: 'notice' as const, summary: `测试计划 #${frames}: ${pendingTest.title.slice(0, 40)}` },
                })
                ctx.logger.info('[quiet-driver] test-plan-frame #%d → %s', frames, pendingTest.title.slice(0, 60))
                agent.followup(message)
                // #006 应答沉淀: 等主会话执行完测试, 提取结果写入 output
                const testResponse = await extractAssistantResponse(ctx, agent)
                await logFrame(config.thinkLogPath, {
                  ts: Date.now(), kind: 'test-plan-frame', frameNo: frames,
                  goalId: pendingTest.id, goalTitle: pendingTest.title,
                  nextAction: `执行测试: ${pendingTest.title}`, session: sessionId, output: testResponse,
                })
                return  // 本次 tick 已用于测试计划, 不再发评估帧
              }
              // #006b 测试自动再产(2026-09-07 20:5x): test-pending 空 ≠ 无需测试——审视"近期机制改动是否需要新测试"。
              // 用户模式: 每次修好缺陷又滑回待命(候选/oq有再生, 测试没有)→ 队列空时发审视帧, 主会话判断是否生成新测试。
              // 防止空转: 审视帧节流——记录上次审视时间, 间隔内不重复发(由下方 lastTestReviewAt 控制)。
              if (Date.now() - lastTestReviewAt > 60 * 60 * 1000) {  // 1h 审视一次(空队列时)
                lastTestReviewAt = Date.now()
                const reviewMessage = createUserMessage({
                  content: [{ type: 'text', text: buildTestReviewFrameText(carrier) }],
                  source: { kind: 'plugin', plugin: 'quiet-driver', form: 'notice' as const, summary: `测试审视 #${frames}: 近期改动是否需要新测试` },
                })
                ctx.logger.info('[quiet-driver] test-review-frame #%d: 队列空, 审视近期改动')
                agent.followup(reviewMessage)
                const reviewResponse = await extractAssistantResponse(ctx, agent)
                await logFrame(config.thinkLogPath, {
                  ts: Date.now(), kind: 'test-review-frame', frameNo: frames,
                  goalId: 'test-review', goalTitle: '审视近期机制改动是否需要新测试',
                  nextAction: '审视→生成新测试或标注无需求', session: sessionId, output: reviewResponse,
                })
                return  // 本次 tick 已用于测试审视
              }
            }
            if (stalled.length > 0) {
              ctx.logger.info('[quiet-driver] action-frame #%d: %d 目标停滞(≥3次未推进), 无 ready 目标可推',
                frames, stalled.length)
              // 停滞目标不重复轰炸, 由评估帧携带(主会话应升级处理)
            }
          }
        } catch (error: unknown) {
          console.error('[quiet-driver] action frame check failed:', error)
        }
        // 无行动帧可发(无 active 目标/冷却中) → 走常规直驱评估帧。
        void readLastFrameContext(config.thinkLogPath).then(async (frameCtx) => {
          const escalated = frameCtx.consecutiveIncremental >= MAX_INCREMENTAL_FRAMES
          const mode = chooseFrameMode(frameCtx.output, escalated ? MAX_INCREMENTAL_FRAMES : 0)
          // v23 补上下文: 读目标池快照, 让帧察觉未完成目标。
          const goals = await readGoalsSnapshot(config.goalsPoolPath)
          // #003 诱导探索: 上帧确认态(收敛) → 取诱导问题注入。
          const prevConfirmed = frameCtx.output !== undefined && /无变化|没有变化|未变|没变|无新增|无实质变化|实质相同|与上帧相同|与上次相同|一致|无异常变化|基本相同|无实质推进|无新观察/.test(frameCtx.output)
          // #003b 探索源选择: 开放问题账本(具体锚点)为主, 诱导表(泛化)为 fallback。
    const openQ = await pickOpenQuestion(config.openQuestionsPath)
    const inducement = openQ !== null
      ? { id: openQ.id, question: openQ.question, category: '开放问题' }
      : ((escalated || prevConfirmed) ? await pickInducement(config.inducementsPath) : null)
          if (dispatchSuspended()) {
            beat('dispatch-suspended', { frames })
            return
          }
          const message = createUserMessage({
            content: [{ type: 'text', text: buildFrameText(carrier, frameCtx.output, escalated ? MAX_INCREMENTAL_FRAMES : 0, goals, inducement) }],
            source: { kind: 'plugin', plugin: 'quiet-driver', form: 'notice' as const, summary: `三问帧 #${frames}` },
          })
          ctx.logger.info('[quiet-driver] wake #%d: direct followup to %s (真正空闲, %s)', frames, sessionId, mode)
          agent.followup(message)
          // 自主进化 #001: direct-frame 应答落盘——等主会话应答完, 提取最后 assistant 文本写入 output。
          // (原 output 恒空 = 空闲唤醒的认知产物全丢; 补上沉淀环, 不需主会话自律。)
          const responseText = await extractAssistantResponse(ctx, agent)
          // cl-091: 判定本帧是否真被消费(输出与上一帧逐字相同 = 没被消费)。
          const consumed = noteDispatchResult(responseText)
          // 记录直驱帧到 think-log（含协议模式+主会话应答产出），供 v18 下帧参考。
          await logFrame(config.thinkLogPath, {
            ts: Date.now(), kind: 'direct-frame', frameNo: frames, mode,
            session: sessionId, output: responseText,  // 不再恒空——应答沉淀
            consumed,
          })
          if (responseText.length > 0) {
            ctx.logger.info('[quiet-driver] direct-frame #%d response persisted (%d chars)', frames, responseText.length)
          }
          // #004 静默降频(校准 2026-09-07 11:0x 用户批评"为什么一直关注打扰用户——三问设计出来是要自进化"):
          // 原语义: 连续确认帧 → 静默跳过 = 纯空白(用户离线期停止思考)。
          // 校准后语义: 短响应确认态达阈值 → 不再静默空白, 而是"降频提质"——
          // 本 tick 立即走深度模式(全检+诱导, 由下方正常帧路径处理), silentSkipUntil 只防 5min 高频轰炸。
          // 即: 4 次浅确认 → 1 次深全检, 而非 4 次浅确认 → 25min 空白。思考不停, 只是从浅频转深低频。
          if (responseText.length < 600) {
            silentStreak += 1
            if (silentStreak >= SILENT_STREAK_MAX) {
              silentSkipUntil = Date.now() + SILENT_SKIP_MS
              ctx.logger.info('[quiet-driver] #004 depth mode: %d 连续确认帧 → 转深度帧(降频提质, 非空白静默) %d 分钟窗口',
                silentStreak, Math.round(SILENT_SKIP_MS / 60000))
              silentStreak = 0
              // 校准: 触发点不 return——继续走下方 onlyWhenIdle 深度帧路径(本 tick 已带 goals/诱导上下文,
              // 由评估帧模式判定: 短确认链后 escalated=false 但 prevConfirmed=true → 诱导注入 → 深思考)
            }
          } else {
            silentStreak = 0  // 有探索/长响应 = 非确认态, 重置
          }
        }).catch((error: unknown) => { console.error('[quiet-driver] direct frame build failed:', error) })
      })()
    }
  }, config.intervalMs)

  timer.unref?.()

  // Cordis plugin convention: return a cleanup disposer (not ctx.on('dispose')).
  return () => {
    clearInterval(timer)
    ctx.logger.info('[quiet-driver] disposed after %d ticks', frames)
  }
}
