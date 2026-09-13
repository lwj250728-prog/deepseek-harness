import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MessageId, freezeMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { meta } from '../../session-persistence/tests/contract.ts'

/**
 * The **unbounded fallback** of `readTail`: a provider that cannot read a
 * bounded window must still serve the whole transcript, and it must say so —
 * `truncated: false`.
 *
 * Added 2026-09-13 (tp-195). Measured gap: the existing tail suite never
 * exercises this branch (the JSONL backend always implements `loadStoredTail`),
 * so lying here (`truncated: true`) left **every** existing test green — the
 * knife was verified to pass through all of them before this file existed.
 *
 * The branch is reached by shadowing the instance method with `undefined`,
 * which is exactly what a provider without bounded reads looks like to the
 * coordinator (`this.backend.loadStoredTail !== undefined`).
 */
const dirs: string[] = []

async function freshRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-jsonl-fallback-'))
  dirs.push(dir)
  return dir
}

/** One turn's events: a user group and an assistant group whose chunks precede its message.
 * 逐字取自同目录 tail.spec.ts —— 手搓事件形状会被 `adoptSessionEvent` 拒(实测失败), fixture 必须复用合法构造器。 */
function turnEvents(turn: number, baseSeq: number): SessionEvent[] {
  const chunkSeqs = [baseSeq + 3, baseSeq + 4]
  return [
    { type: 'turn/start', seq: baseSeq, time: baseSeq, data: { turn } },
    { type: 'user/message', seq: baseSeq + 1, time: baseSeq + 1, data: freezeMessage({
      id: MessageId(`user-${turn}`),
      role: 'user',
      content: [{ type: 'text', text: `q${turn}` }],
      source: { kind: 'user' },
    }), surfaceOp: 'append' },
    { type: 'step/start', seq: baseSeq + 2, time: baseSeq + 2, data: { turn, step: 1 } },
    ...chunkSeqs.map((seq, index) => ({
      type: 'assistant/chunk' as const,
      seq,
      time: seq,
      data: { turn, step: 1, chunk: { type: 'text-delta' as const, index: 0, text: `a${index}` } },
    })),
    { type: 'assistant/message', seq: baseSeq + 5, time: baseSeq + 5, data: {
      turn,
      step: 1,
      message: freezeMessage({
        id: MessageId(`assistant-${turn}`),
        role: 'assistant',
        content: [{ type: 'text', text: `a${turn}` }],
        source: { kind: 'model', ...{ provider: 'mock', model: 'mock' } },
      }),
    }, surfaceOp: 'append', sourceEventSeqs: chunkSeqs },
    { type: 'step/end', seq: baseSeq + 6, time: baseSeq + 6, data: { turn, step: 1 } },
    { type: 'turn/end', seq: baseSeq + 7, time: baseSeq + 7, data: { turn, reason: { kind: 'completed' } } },
  ]
}

/** N turns of valid events. */
function log(turns: number): SessionEvent[] {
  const events: SessionEvent[] = []
  for (let turn = 1; turn <= turns; turn += 1) events.push(...turnEvents(turn, events.length))
  return events
}

async function mounted(): Promise<{ ctx: Context, persistence: JsonlSessionPersistence }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root: await freshRoot(), compression: 'none' })
  const persistence = ctx.sessionPersistence
  // simulate a provider without bounded reads: own property shadows the prototype method
  ;(persistence as unknown as { loadStoredTail: undefined }).loadStoredTail = undefined
  return { ctx, persistence }
}

describe('readTail: provider without bounded reads (unbounded fallback)', () => {
  it('serves the whole transcript and reports truncated=false (never lies about truncation)', async () => {
    const { ctx, persistence } = await mounted()
    try {
      const header = meta('fallback-whole', '/work')
      const body = log(3)
      await persistence.create(header)
      await persistence.append(header.id, body)

      // remember: the bounded path is artificially unavailable here
      const tail = await persistence.readTail(header.id, { retainMessages: 1 })
      expect(tail.truncated).toBe(false)            // ★ 有界能力缺失时不得谎报截断
      expect(tail.events.length).toBe(body.length)  // 整份返回(不做窗口)
      expect(tail.meta.id).toBe(header.id)

      const seqs = tail.events.map(event => event.seq)
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
      expect(seqs.at(-1)).toBe(body.at(-1)?.seq)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects an unknown session instead of pretending it served nothing', async () => {
    const { ctx, persistence } = await mounted()
    try {
      await expect(persistence.readTail('absent' as SessionId, { retainMessages: 1 }))
        .rejects.toThrow(/not found/u)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('still reports truncated=false for a large log (fallback is per-transcript, not per-page)', async () => {
    const { ctx, persistence } = await mounted()
    try {
      const header = meta('fallback-large', '/work')
      const body = log(40)
      await persistence.create(header)
      await persistence.append(header.id, body)
      const tail = await persistence.readTail(header.id, { retainMessages: 2 })
      expect(tail.truncated).toBe(false)
      expect(tail.events.length).toBe(body.length)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

// keep the temp roots tidy without pulling in a global afterEach hook
process.on('exit', () => { void Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))) })
void MessageId
