import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as CognitiveInjectInvariant from '@deepseek-ai/dsh-cognitive-inject/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(CognitiveInjectInvariant)
  return ctx
}

function injectionEvent(text: string, plugin = 'cognitive-inject'): SessionEvent<'user/message'> {
  return {
    type: 'user/message',
    seq: 0,
    time: 1,
    data: createUserMessage({
      content: [{ type: 'text', text }],
      source: plugin === 'cognitive-inject'
        ? {
          kind: 'plugin',
          plugin,
          form: 'snapshot',
          sections: [{ name: plugin, text }],
        }
        : { kind: 'plugin', plugin },
    }),
  }
}

function openSession(): Session {
  const session = Session.create(SessionId('cognitive-inject-invariant'))
  session.append('turn/start', { turn: 1 })
  return session
}

describe('cognitive-inject invariants', () => {
  it('accepts a canonical reference block with the durable preamble', async () => {
    const ctx = await setup()
    const text = '【认知经验参考】以下是与当前情境相关的历史经验，供参考借鉴（不要虚构为当前事实）：\n'
      + '- [exp_1] (相关度 0.52) 测试挂起。修复死循环。测试恢复。'
    expect(() => { ctx.emit('session/event', openSession(), injectionEvent(text)) }).not.toThrow()
  })

  it('rejects an injection whose text does not open with the preamble', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.emit('session/event', openSession(), injectionEvent('随便一段话'))
    }).toThrow(/preamble/)
  })

  it('ignores messages not owned by the cognitive-inject plugin', async () => {
    const ctx = await setup()
    const text = '【认知经验参考】以下是与当前情境相关的历史经验，供参考借鉴（不要虚构为当前事实）：\n- [exp_1] x'
    // A foreign-plugin message with the same shape is outside this package's
    // ownership: the invariant must not claim or reject it.
    expect(() => {
      ctx.emit('session/event', openSession(), injectionEvent(text, 'other-plugin'))
    }).not.toThrow()
  })

  it('rejects a multi-block injection', async () => {
    const ctx = await setup()
    const text = '【认知经验参考】以下是与当前情境相关的历史经验，供参考借鉴（不要虚构为当前事实）：\n- [exp_1] x'
    const event: SessionEvent<'user/message'> = {
      type: 'user/message',
      seq: 0,
      time: 1,
      data: createUserMessage({
        content: [
          { type: 'text', text },
          { type: 'text', text: 'extra' },
        ],
        source: {
          kind: 'plugin',
          plugin: 'cognitive-inject',
          form: 'snapshot',
          sections: [{ name: 'cognitive-inject', text }],
        },
      }),
    }
    expect(() => { ctx.emit('session/event', openSession(), event) }).toThrow(/one text block/)
  })
})
