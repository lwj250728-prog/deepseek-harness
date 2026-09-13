/**
 * Output-budget clamping: the arithmetic that keeps a request inside the window.
 *
 * The failure this guards is not "the reply was short" — it is a session that
 * can no longer make ANY request, because input plus the declared output budget
 * exceeded the model's window while every compaction threshold (which watches
 * input alone) still read as comfortable.
 */
import { describe, expect, it } from 'vitest'
import {
  MIN_OUTPUT_TOKENS, clampOutputBudget, estimateInputTokens,
} from '../src/output-budget.ts'

describe('estimateInputTokens', () => {
  it('tracks the provider real ratio for ASCII and counts CJK per character', () => {
    // Calibration point: the provider counted 793,101 input tokens for a payload
    // JSON of ~3.14MB, so ASCII-ish traffic runs ~4 bytes per token.
    expect(estimateInputTokens('a'.repeat(4000))).toBe(1000)
    // CJK: three UTF-8 bytes per character ≈ one token per character.
    expect(estimateInputTokens('中'.repeat(300))).toBe(300)
    // Mixed content counts each class on its own scale.
    expect(estimateInputTokens(`${'a'.repeat(400)}${'中'.repeat(100)}`)).toBe(200)
  })
})

describe('clampOutputBudget', () => {
  it('leaves a request that already fits alone', () => {
    expect(clampOutputBudget({ requestedMaxTokens: 1000, contextWindow: 10_000, estimatedInputTokens: 2000 }))
      .toEqual({ maxTokens: 1000, remaining: 6976 })
  })

  it('clamps the budget that would push the request over the window', () => {
    // The production shape: a 1,048,576 window, ~793k input tokens, and the
    // model's 256k default output cap.
    const budget = clampOutputBudget({
      requestedMaxTokens: 256_000,
      contextWindow: 1_048_576,
      estimatedInputTokens: 793_101,
    })
    expect(budget.clampedFrom).toBe(256_000)
    expect(budget.remaining).toBe(1_048_576 - 793_101 - 20_971)
    expect(budget.maxTokens).toBe(budget.remaining)
  })

  it('never asks for less than a usable reply, even when the input ate the window', () => {
    const budget = clampOutputBudget({
      requestedMaxTokens: 256_000,
      contextWindow: 1_048_576,
      estimatedInputTokens: 1_048_000,
    })
    // No valid budget is left: the floor keeps the request well-formed, and the
    // provider's refusal is the honest signal that this conversation needs
    // compaction rather than a shrinking answer.
    expect(budget.maxTokens).toBe(MIN_OUTPUT_TOKENS)
    expect(budget.clampedFrom).toBe(256_000)
  })

  it('stays out of the way when the adapter cannot know the window or the budget', () => {
    expect(clampOutputBudget({ contextWindow: 1000, estimatedInputTokens: 10 })).toEqual({})
    expect(clampOutputBudget({ requestedMaxTokens: 500, estimatedInputTokens: 10 })).toEqual({ maxTokens: 500 })
    expect(clampOutputBudget({ requestedMaxTokens: 500, contextWindow: 0, estimatedInputTokens: 10 }))
      .toEqual({ maxTokens: 500 })
  })
})
