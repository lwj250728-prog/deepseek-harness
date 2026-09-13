/**
 * Output-budget clamping for one chat-completions request.
 *
 * A provider rejects a request whose INPUT plus declared OUTPUT budget exceeds
 * the model's context window. Nothing upstream reserved room for the output:
 * an agent request carries the model's default output cap (256k on this
 * deployment) while the compaction threshold only watches INPUT pressure
 * (a fraction of the window). A session can therefore sit comfortably below the
 * compaction threshold and still be unable to make any request at all — which is
 * exactly how a long conversation dies with a context-length error instead of
 * compacting.
 *
 * Clamping here is the last line of defence: it sees the real serialized
 * payload and the resolved window together, and it covers every caller (main
 * loop, subagents, compaction summarization, wake frames) rather than one path.
 *
 * @module @deepseek-ai/dsh-llm-deepseek/output-budget
 */

/** Smallest output budget this adapter will ask for: below it a reply cannot be useful. */
export const MIN_OUTPUT_TOKENS = 4096

/** Fraction of the window kept free for estimation error and provider overhead. */
const RESERVE_RATIO = 0.02

/** Absolute floor of the free-space reserve. */
const MIN_RESERVE_TOKENS = 1024

/**
 * Estimate the input tokens of one serialized payload.
 *
 * UTF-8 bytes over three is deliberately conservative in both directions this
 * harness sees: ASCII costs ~1/3 token per byte (over-estimated, safe) and CJK
 * costs ~1 token per three bytes (exact). Under-estimating would hand the
 * provider an over-budget request, so the estimate errs upward.
 * @param text - the serialized request body.
 * @returns an estimated input-token count.
 */
export function estimateInputTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3)
}

/** What one clamp decision needs to know. */
export interface OutputBudgetInput {
  /** The output budget the caller asked for, when it asked for one. */
  readonly requestedMaxTokens?: number
  /** The model's context window, when the adapter knows it. */
  readonly contextWindow?: number
  /** Estimated input tokens of this request. */
  readonly estimatedInputTokens: number
}

/** One clamp decision. */
export interface OutputBudget {
  /** The budget to send: `undefined` leaves the provider's own default in place. */
  readonly maxTokens?: number
  /** The caller's original budget when this call reduced it. */
  readonly clampedFrom?: number
  /** Free space the clamp reserved (window minus input minus margin). */
  readonly remaining?: number
}

/**
 * Clamp one requested output budget to the space actually left in the window.
 *
 * A request already inside the window is returned untouched (including the
 * `undefined` case, where the provider's own default applies and this adapter
 * has no business inventing a cap).
 * @param input - the request's budget, window, and estimated input size.
 * @returns the budget to send, plus what was clamped when it changed.
 */
export function clampOutputBudget(input: OutputBudgetInput): OutputBudget {
  const { requestedMaxTokens, contextWindow, estimatedInputTokens } = input
  if (requestedMaxTokens === undefined) return {}
  if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return { maxTokens: requestedMaxTokens }
  }
  const reserve = Math.max(MIN_RESERVE_TOKENS, Math.floor(contextWindow * RESERVE_RATIO))
  const remaining = contextWindow - estimatedInputTokens - reserve
  if (requestedMaxTokens <= remaining) return { maxTokens: requestedMaxTokens, remaining }
  // Keep asking for something usable: when the input has already eaten the
  // window there is no valid budget left, and the provider's refusal is the
  // honest signal that this conversation needs compaction instead.
  return {
    maxTokens: Math.max(MIN_OUTPUT_TOKENS, remaining),
    clampedFrom: requestedMaxTokens,
    remaining,
  }
}
