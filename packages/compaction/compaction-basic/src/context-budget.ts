/**
 * Context-length decisions for the basic compaction backend.
 *
 * Two questions live here, and both exist because a conversation can reach a
 * state where the ordinary pressure path cannot help it:
 *
 * 1. WHEN must compaction run? Pressure normally gates on a fraction of the
 *    window, but a prompt that already EXCEEDS the window can no longer make any
 *    request at all — the provider rejects it, the summarizer's own request is
 *    rejected too, and the session is stuck. Compaction is the only way out, so
 *    past the window it runs regardless of the threshold.
 *
 * 2. WHAT can be summarized? The default summarizer deliberately replays the
 *    whole region so the provider's prefix cache stays warm — which is exactly
 *    what cannot work when the region itself is larger than the window. The
 *    region is then bounded to what fits, and the omission is stated in the
 *    directive so the checkpoint itself records it instead of claiming to cover
 *    a span the model never saw.
 *
 * @module @deepseek-ai/dsh-compaction-basic/context-budget
 */

import type { Message } from '@deepseek-ai/dsh-llm'

/** Fraction of the window kept free for estimation error and provider overhead. */
const RESERVE_RATIO = 0.02

/** Absolute floor of the free-space reserve. */
const MIN_RESERVE_TOKENS = 1024

/** Characters that occupy roughly one token each in these vocabularies. */
const DENSE_CHARACTER = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/gu

/**
 * Estimate tokens of one text payload.
 *
 * Calibrated against this deployment's own traffic: a provider counted 793,101
 * input tokens for a payload JSON of ~3.14MB (≈4 bytes per token), while CJK
 * text runs about one token per character. Under-estimating would hand the
 * provider an over-budget request, so the ASCII side rounds up.
 * @param text - the serialized payload.
 * @returns an estimated token count.
 */
export function estimateTokens(text: string): number {
  const dense = text.match(DENSE_CHARACTER)?.length ?? 0
  const restBytes = Math.max(0, Buffer.byteLength(text, 'utf8') - dense * 3)
  return Math.ceil(restBytes / 4) + dense
}

/** Whether pressure demands compaction now, ignoring the threshold past the window. */
export function shouldCompactNow(
  measurement: { readonly totalTokens: number },
  spec: { readonly thresholdTokens: number; readonly contextWindow: number },
): boolean {
  if (measurement.totalTokens >= spec.contextWindow) return true
  return measurement.totalTokens >= spec.thresholdTokens
}

/** The outcome of bounding one summarization region to the model's window. */
export interface BoundedRegion {
  /** The messages to replay, oldest first. */
  readonly messages: readonly Message[]
  /** How many of the region's oldest messages were left out. */
  readonly omittedMessages: number
}

/**
 * Bound a summarization region to what the model can actually accept.
 *
 * The region is the span being replaced, so dropping its oldest messages loses
 * detail the checkpoint cannot restate — which is why the caller must state the
 * omission in the directive rather than summarize silently. Keeping the NEWEST
 * messages is the right half to keep: they are the ones the following turns build
 * on directly.
 * @param messages - the region, in surface order.
 * @param contextWindow - the summarizer target's window; absent or invalid keeps every message.
 * @param outputBudget - the summarization call's own output reservation.
 * @returns the bounded region and how many messages it left out.
 */
export function boundRegionToWindow(
  messages: readonly Message[],
  contextWindow: number | undefined,
  outputBudget: number,
): BoundedRegion {
  if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return { messages, omittedMessages: 0 }
  }
  const reserve = Math.max(MIN_RESERVE_TOKENS, Math.floor(contextWindow * RESERVE_RATIO))
  const budget = contextWindow - outputBudget - reserve
  const cost = (message: Message): number => estimateTokens(JSON.stringify(message))
  let total = 0
  let keepFrom = messages.length
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    total += cost(messages[index] as Message)
    if (total > budget) break
    keepFrom = index
  }
  if (keepFrom === 0) return { messages, omittedMessages: 0 }
  return { messages: messages.slice(keepFrom), omittedMessages: keepFrom }
}
