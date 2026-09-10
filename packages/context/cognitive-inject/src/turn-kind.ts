/**
 * Turn-type classification for the injection gate (cl-114 / goal-adoption-rate).
 *
 * Measured evidence (main session, 852 settled injections classified by turn):
 *   user turns        13 / 252 =  5.2%   ← the only volume-carrying producer
 *   action frames      2 /  99 =  2.0%   ← frames that execute a concrete goal step
 *   reflective frames  0 / 501 =  0.0%   ← 三问 / 测试审视 / 测试计划 / 旁路三问
 * Reflective frames are 59% of all injection volume and produced **zero**
 * citations: the injected memory competes with a large task context and there
 * is no request for it to be decisive about. Unknown non-user senders behaved
 * the same (0 / 24). So the gate is: inject on user turns, inject on action
 * frames with a stricter margin, stay silent elsewhere.
 *
 * Classification reads the step's user messages as delivered (source kind,
 * plugin, form, summary) and the frame headline when present — deterministic,
 * no LLM call.
 * @module @deepseek-ai/dsh-cognitive-inject/turn-kind
 */

/** Who is asking for this step. */
export type TurnKind = 'user' | 'action-frame' | 'reflective-frame' | 'unknown'

/** Minimal message slice this classifier reads. */
export interface TurnKindMessage {
  readonly content?: readonly { readonly type?: string, readonly text?: string }[]
  readonly source?: {
    readonly kind?: string
    readonly plugin?: string
    readonly form?: string
    readonly summary?: string
  }
}

/** Headlines that mark an action frame (it carries a concrete nextAction). */
const ACTION_FRAME_MARKERS = ['【行动帧】', '行动帧']
/** Headlines that mark a reflective frame (self-evaluation, no external task). */
const REFLECTIVE_FRAME_MARKERS = [
  '【三问帧】', '三问帧', '【测试审视帧】', '测试审视', '【测试计划帧】', '测试计划',
  '旁路三问', '【迁移帧】', '迁移帧', '候选孵化',
]

/** Classify one step by its delivered messages.
 * @param messages - the step's user-side messages.
 * @returns which kind of turn the gate should treat this as.
 */
export function classifyTurnKind(messages: readonly TurnKindMessage[]): TurnKind {
  const texts: string[] = []
  let sawAction = false
  let sawReflective = false
  let sawPluginFrame = false
  for (const message of messages) {
    const source = message.source ?? {}
    if (source.kind === 'user') return 'user'
    const headline = `${source.summary ?? ''} ${source.form ?? ''}`
    const body = (message.content ?? [])
      .filter(block => block.type === 'text')
      .map(block => block.text ?? '')
      .join(' ')
    texts.push(`${headline} ${body}`)
    if (source.plugin === 'quiet-driver') sawPluginFrame = true
  }
  const joined = texts.join(' ')
  sawAction = ACTION_FRAME_MARKERS.some(marker => joined.includes(marker))
  sawReflective = REFLECTIVE_FRAME_MARKERS.some(marker => joined.includes(marker))
  if (sawAction) return 'action-frame'
  if (sawReflective) return 'reflective-frame'
  if (sawPluginFrame) return 'reflective-frame'  // 未识别的插件帧: 实测同为 0 采纳, 归入静默类
  return 'unknown'
}

/** Inputs the injection gate decides on. */
export interface GateInput {
  /** Turn kind (see {@link classifyTurnKind}). */
  readonly kind: TurnKind
  /** How many turns this session has already run (context dilution proxy). */
  readonly sessionTurns: number
  /** At/above this the session counts as established (default 20). */
  readonly establishedSessionTurns: number
}

/** What the gate does with this step. */
export type GateDecision = 'inject' | 'inject-strict' | 'skip'

/**
 * Decide whether this step may receive an injection.
 *
 * Evidence: in the established 1100-turn session, reflective frames produced
 * 0 adoptions in 501 injections, while the same frames in fresh 1–3-turn
 * sessions (subagent/bypass) produced ~17%. User turns adopt at ~5% and action
 * frames at ~2% in both settings. So: never spend budget on a reflective frame
 * inside an established session; keep everything else, with action frames held
 * to a stricter margin.
 * @param input - the turn kind and session maturity.
 * @returns the gate decision for this step.
 */
export function decideInjection(input: GateInput): GateDecision {
  if (input.kind === 'user' || input.kind === 'unknown') return 'inject'
  const established = input.sessionTurns >= input.establishedSessionTurns
  if (input.kind === 'action-frame') return established ? 'inject-strict' : 'inject'
  return established ? 'skip' : 'inject'
}
