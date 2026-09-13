/**
 * Context-length decisions: when compaction must run, and what it can summarize.
 *
 * Both functions exist for the same failure: a conversation whose prompt already
 * exceeds the model window. The threshold cannot help it, and neither can a
 * summarizer that replays the whole oversized span.
 */
import { describe, expect, it } from 'vitest'
import { boundRegionToWindow, estimateTokens, shouldCompactNow } from '../src/context-budget.ts'

const spec = { thresholdTokens: 800_000, contextWindow: 1_000_000 }

describe('shouldCompactNow', () => {
  it('uses the threshold while the prompt still fits the window', () => {
    expect(shouldCompactNow({ totalTokens: 799_999 }, spec)).toBe(false)
    expect(shouldCompactNow({ totalTokens: 800_000 }, spec)).toBe(true)
  })

  it('ignores the threshold once the prompt exceeds the window', () => {
    // The state a session reaches when earlier compactions could not run: no
    // request can succeed, so waiting for the threshold would wait forever.
    expect(shouldCompactNow({ totalTokens: 1_000_000 }, spec)).toBe(true)
    expect(shouldCompactNow({ totalTokens: 1_046_000 }, spec)).toBe(true)
  })
})

describe('boundRegionToWindow', () => {
  const message = (text: string) => ({
    role: 'user' as const,
    content: [{ type: 'text' as const, text }],
    source: { kind: 'user' as const },
  })

  it('keeps a region that already fits', () => {
    const messages = [message('a'), message('b')]
    const bounded = boundRegionToWindow(messages as never, 1_000_000, 8_192)
    expect(bounded.omittedMessages).toBe(0)
    expect(bounded.messages).toBe(messages)
  })

  it('keeps the NEWEST messages when the region itself overflows', () => {
    // Each message is ~25k tokens: 60 of them cannot fit a 100k window.
    const big = 'x'.repeat(100_000)
    const messages = Array.from({ length: 60 }, (_, index) => message(`${big}${index}`))
    const bounded = boundRegionToWindow(messages as never, 100_000, 8_192)
    expect(bounded.omittedMessages).toBeGreaterThan(0)
    expect(bounded.messages.length + bounded.omittedMessages).toBe(messages.length)
    // The tail survives, so the turns that follow build on what remains visible.
    expect(bounded.messages.at(-1)).toBe(messages.at(-1))
    expect(bounded.omittedMessages).toBe(messages.length - bounded.messages.length)
  })

  it('leaves the region alone when the window is unknown', () => {
    const messages = [message('a'), message('b')]
    expect(boundRegionToWindow(messages as never, undefined, 8_192).omittedMessages).toBe(0)
    expect(boundRegionToWindow(messages as never, 0, 8_192).omittedMessages).toBe(0)
  })
})

describe('estimateTokens', () => {
  it('matches the calibrated ratio for ASCII and counts CJK per character', () => {
    expect(estimateTokens('a'.repeat(4000))).toBe(1000)
    expect(estimateTokens('中'.repeat(300))).toBe(300)
  })
})
