import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import * as SituationalStateInvariant from '@deepseek-ai/dsh-situational-state/invariant'
import { CONTEXT_PREAMBLE, SOURCE_NAME, WAKE_PREAMBLE } from '@deepseek-ai/dsh-situational-state'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(SituationalStateInvariant)
  return ctx
}

function messageEvent(text: string, plugin = SOURCE_NAME): SessionEvent<'user/message'> {
  return {
    type: 'user/message',
    seq: 0,
    time: 1,
    data: {
      id: MessageId(`msg-${Math.random().toString(36).slice(2, 8)}`),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin },
    },
  }
}

function openSession(): Session {
  const session = Session.create(SessionId('situational-invariant'))
  session.append('turn/start', { turn: 1 })
  return session
}

describe('situational-state invariants', () => {
  it('accepts a canonical context block with the durable preamble', async () => {
    const ctx = await setup()
    const text = `${CONTEXT_PREAMBLE}当前会话最近提交的情景状态（刚刚）：正在验证链表机制`
    expect(() => { ctx.emit('session/event', openSession(), messageEvent(text)) }).not.toThrow()
  })

  it('accepts a canonical wake block with the durable wake preamble', async () => {
    const ctx = await setup()
    const text = `${WAKE_PREAMBLE}已到自决更新时间。请根据当前会话判断是否需要更新情景状态链表。`
    expect(() => { ctx.emit('session/event', openSession(), messageEvent(text)) }).not.toThrow()
  })

  it('rejects a message whose text opens with neither preamble', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.emit('session/event', openSession(), messageEvent('随便一段话'))
    }).toThrow(/preamble/)
  })

  it('ignores messages not owned by the situational-state plugin', async () => {
    const ctx = await setup()
    const text = `${CONTEXT_PREAMBLE}当前会话最近提交的情景状态：x`
    expect(() => {
      ctx.emit('session/event', openSession(), messageEvent(text, 'other-plugin'))
    }).not.toThrow()
  })

  it('rejects a multi-block message', async () => {
    const ctx = await setup()
    const text = `${CONTEXT_PREAMBLE}当前会话最近提交的情景状态：x`
    const event: SessionEvent<'user/message'> = {
      type: 'user/message',
      seq: 0,
      time: 1,
      data: {
        id: MessageId('msg-multi'),
        role: 'user',
        content: [
          { type: 'text', text },
          { type: 'text', text: 'extra' },
        ],
        source: { kind: 'plugin', plugin: SOURCE_NAME },
      },
    }
    expect(() => { ctx.emit('session/event', openSession(), event) }).toThrow(/one text block/)
  })
})
