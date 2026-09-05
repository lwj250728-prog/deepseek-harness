import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { EmbeddingScorer } from '../src/embedding.ts'
import type { EmbeddingTransport } from '../src/embedding.ts'

/** Deterministic fake transport: fixed vectors, call-counted. */
function fakeTransport(vectors: Record<string, number[]>): EmbeddingTransport & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async embed(text: string): Promise<number[]> {
      calls.push(text)
      const vector = vectors[text]
      if (vector === undefined) throw new Error(`no vector for "${text}"`)
      return vector
    },
  }
}

const CONFIG = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-embedding', apiKeyEnv: 'DEEPSEEK_API_KEY' }

describe('EmbeddingScorer', () => {
  it('embeds via the injected transport and caches per text', async () => {
    const ctx = new Context()
    const transport = fakeTransport({ '晨跑五公里': [1, 0, 0], '熬夜刷剧': [0, 1, 0] })
    const scorer = new EmbeddingScorer(ctx, CONFIG, transport)

    await expect(scorer.embed('晨跑五公里')).resolves.toEqual([1, 0, 0])
    await expect(scorer.embed('晨跑五公里')).resolves.toEqual([1, 0, 0])
    await expect(scorer.embed('熬夜刷剧')).resolves.toEqual([0, 1, 0])
    // The repeated text hit the cache: only two transport calls.
    expect(transport.calls).toEqual(['晨跑五公里', '熬夜刷剧'])
    await ctx.fiber.dispose()
  })

  it('returns null (hash fallback) when the transport fails', async () => {
    const ctx = new Context()
    const transport: EmbeddingTransport = {
      embed: async () => { throw new Error('network down') },
    }
    const scorer = new EmbeddingScorer(ctx, CONFIG, transport)
    await expect(scorer.embed('anything')).resolves.toBeNull()
    // Failures are not cached: a later success still works.
    const recovering: EmbeddingTransport = {
      embed: async () => [0, 0, 1],
    }
    const scorer2 = new EmbeddingScorer(ctx, CONFIG, recovering)
    await expect(scorer2.embed('anything')).resolves.toEqual([0, 0, 1])
    await ctx.fiber.dispose()
  })

  it('logs once and returns null when no API key exists and no transport is injected', async () => {
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const scorer = new EmbeddingScorer(ctx, CONFIG)
    await expect(scorer.embed('text')).resolves.toBeNull()
    await expect(scorer.embed('text')).resolves.toBeNull()
    // Key failure is logged once, not per call.
    expect(warn.mock.calls.filter(call => String(call[0]).includes('no API key'))).toHaveLength(1)
    await ctx.fiber.dispose()
  })
})
