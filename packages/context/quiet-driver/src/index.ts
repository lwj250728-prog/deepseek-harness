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
}

/** Frame text base (v18 自适应: 全检/增量两种协议)。 */
function frameHeader(carrier: CarrierIdentity, mode: 'full' | 'incremental', goalsSnapshot?: string): string {
  const protocol = mode === 'full'
    ? '检查协议：全检（环境有变化或陌生——逐层细查）'
    : '检查协议：增量（环境与上帧高度相似=熟悉域——只比对差异与异常，不重复盘点）'
  return [
    '【三问帧】(source: plugin/quiet-driver, form: epistemic-frame)',
    '你正在做一次例行自我评估。这是旁路思考——请直接回答，不要执行额外任务。',
    '',
    '【载体身份】(v20 自我锚定——你运行在以下实例上，若与上次不同即经历载体迁移):',
    `  实例 PID: ${carrier.pid} | 启动: ${carrier.startedAt} | 主机: ${carrier.hostname}`,
    '',
    `【${protocol}】`,
    '',
    goalsSnapshot !== undefined ? `【当前目标池】(供 Q2 核对——这些目标未完成，你应察觉并在评估中考虑)\n${goalsSnapshot}\n` : '',
    '',
  ].join('\n')
}

/** 全检帧文本：陌生/有变化时用（v17 完整三问）。 */
function buildFullFrameText(carrier: CarrierIdentity, goalsSnapshot?: string): string {
  return frameHeader(carrier, 'full', goalsSnapshot)
    + [
      'Q1 环境（全检）：自上次检查以来，环境有什么变化？（引用具体对象；无变化须说明你查证了什么）',
      'Q2 当下（全检）：当前议程中有什么到期或未处理的事？我的认知状态健康吗？（报可数事实）',
      'Q3 预测：什么最可能出错？如果错了怎么发现（证伪信号）？',
      '',
      '回答请控制在 5 句以内，直接给结论。',
    ].join('\n')
}

/** 增量帧文本：环境熟悉（与上帧相似）时用（v18 熟略查）。 */
function buildIncrementalFrameText(carrier: CarrierIdentity, goalsSnapshot?: string): string {
  return frameHeader(carrier, 'incremental', goalsSnapshot)
    + [
      'Q1 环境（增量）：与上帧相比，有什么不同？（重点：异常/新信号/与上帧断言不符处；无则答"与上帧一致"）',
      'Q2 当下（增量）：上帧提到的到期项/风险，进展如何？（只查上帧涉及的，不重新盘点全部）',
      'Q3 预测：上帧最可能出错的点，应验了吗？（证伪信号核对）',
      '',
      '回答请控制在 5 句以内，直接给结论。',
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
function buildFrameText(carrier: CarrierIdentity, prevOutput?: string, consecutiveIncremental = 0, goalsSnapshot?: string): string {
  return chooseFrameMode(prevOutput, consecutiveIncremental) === 'full'
    ? buildFullFrameText(carrier, goalsSnapshot)
    : buildIncrementalFrameText(carrier, goalsSnapshot)
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
        const g = JSON.parse(line) as { title?: string; status?: string; triggerCount?: number }
        if (g.title) {
          goals.push(`- [${g.status ?? '?'}] ${g.title}${g.triggerCount ? ` (触发${g.triggerCount}次)` : ''}`)
        }
      } catch { /* skip */ }
    }
    return goals.length > 0 ? goals.join('\n') : '(目标池为空)'
  } catch {
    return '(目标池不可读)'
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
  const pipeline = ctx.get('cognitivePipeline') as {
    report(input: { predictionId: string; actualOutcome: string; outcomeQuality: number }): Promise<unknown>
  } | undefined
  if (pipeline === undefined) return
  const predictionId = open.predictionId as string
  const frameNo = open.frameNo as number
  await pipeline.report({
    predictionId,
    actualOutcome: `三问帧旁路后续帧结算：预测 #${frameNo} 的关注点未经后续帧确认应验（粗结算，中性质量）`,
    outcomeQuality: 5,
  })
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
    const handle = await agents.create({
      sessionId: SessionId(`quiet-frame-${randomUUID()}`),
      meta: { cwd: process.cwd(), origin: 'subagent' },
      agentOptions: { provider: selection.provider, model: selection.model },
    })
    const agent = handle.agent
    // v18 自适应: 读上帧产出+连续增量计数, 决定全检/增量协议(升级触发器)。
    const frameCtx = await readLastFrameContext(config.thinkLogPath)
    const escalated = frameCtx.consecutiveIncremental >= MAX_INCREMENTAL_FRAMES
    // v23 补上下文: 读目标池快照, 让帧察觉未完成目标。
    const goals = await readGoalsSnapshot(config.goalsPoolPath)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: buildFrameText(carrier, frameCtx.output, escalated ? MAX_INCREMENTAL_FRAMES : 0, goals) }],
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
        const pipeline = ctx.get('cognitivePipeline') as { rememberMeta(input: {
          situation: string; action: string; outcome: string
          utility: { material_gain: number; emotional_valence: number; energy_cost: number }
        }): string } | undefined
        if (pipeline !== undefined) {
          pipeline.rememberMeta({
            situation: `三问帧旁路评估 #${frameNo}（原因：${reason}）。评估时环境状态：${text.slice(0, 400)}`,
            action: 'quiet-driver 旁路三问帧：定时触发独立会话例行自我评估（环境/当下/预测）',
            outcome: text,
            utility: { material_gain: 1, emotional_valence: 0, energy_cost: 2 },
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

  let frames = 0
  const timer = setInterval(async () => {
    if (!config.enabled) return
    const agent = targetAgent()
    if (agent === undefined) {
      ctx.logger.info('[quiet-driver] tick: target agent not live — skip')
      return
    }
    ensureTracking(agent) // attach user-activity listener as soon as the agent exists
    frames += 1
    const userActive = Date.now() - lastUserMsgAt < config.userActiveWindowMs
    if (userActive) {
      // User is actively dialoguing → side-channel, never interrupt the dialog.
      if (config.bypassMode) {
        ctx.logger.info('[quiet-driver] tick #%d: user active — side-channel (载体 B)', frames)
        void runSideChannel(frames, 'user-active')
      } else {
        ctx.logger.info('[quiet-driver] tick #%d: user active — yield', frames)
      }
      return
    }
    if (agent.status !== 'idle') {
      // Not dialoguing but agent busy (long task) → yield, wait for next tick.
      ctx.logger.info('[quiet-driver] tick #%d: quiet but busy — yield', frames)
      return
    }
    if (config.onlyWhenIdle) {
      // Settle the oldest open prediction before a direct frame too (v5).
      if (config.predictionLoop) {
        void settleOldestPrediction(ctx, config.thinkLogPath)
          .catch((error: unknown) => { console.error('[quiet-driver] prediction settle (direct) failed:', error) })
      }
      // v18 自适应: 异步读上帧选协议(含升级触发器), 再 followup。
      void readLastFrameContext(config.thinkLogPath).then(async (frameCtx) => {
        const escalated = frameCtx.consecutiveIncremental >= MAX_INCREMENTAL_FRAMES
        const mode = chooseFrameMode(frameCtx.output, escalated ? MAX_INCREMENTAL_FRAMES : 0)
        // v23 补上下文: 读目标池快照, 让帧察觉未完成目标。
        const goals = await readGoalsSnapshot(config.goalsPoolPath)
        const message = createUserMessage({
          content: [{ type: 'text', text: buildFrameText(carrier, frameCtx.output, escalated ? MAX_INCREMENTAL_FRAMES : 0, goals) }],
          source: { kind: 'plugin', plugin: 'quiet-driver', form: 'notice' as const, summary: `三问帧 #${frames}` },
        })
        ctx.logger.info('[quiet-driver] wake #%d: direct followup to %s (真正空闲, %s)', frames, sessionId, mode)
        agent.followup(message)
        // 记录直驱帧到 think-log（含协议模式），供 v18 下帧参考。
        await logFrame(config.thinkLogPath, {
          ts: Date.now(), kind: 'direct-frame', frameNo: frames, mode,
          session: sessionId, output: '',
        })
      }).catch((error: unknown) => { console.error('[quiet-driver] direct frame build failed:', error) })
    }
  }, config.intervalMs)

  timer.unref?.()

  // Cordis plugin convention: return a cleanup disposer (not ctx.on('dispose')).
  return () => {
    clearInterval(timer)
    ctx.logger.info('[quiet-driver] disposed after %d ticks', frames)
  }
}
