/** Target rebinding: the driver follows its conversation across a handover. */
import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { parsePersistedTarget, rebindTarget, serializeTarget } from '../src/target-binding.ts'

const sid = (value: string): SessionId => value as SessionId

describe('rebindTarget', () => {
  it('follows the conversation when the driver was watching the predecessor', () => {
    expect(rebindTarget(sid('old'), { predecessorId: sid('old'), successorId: sid('new') }))
      .toBe('new')
  })

  it('leaves an unrelated handover alone', () => {
    // The driver keeps its own target when some OTHER session hands over.
    expect(rebindTarget(sid('mine'), { predecessorId: sid('other'), successorId: sid('new') }))
      .toBeUndefined()
    // A notice naming the same session twice must not start a loop.
    expect(rebindTarget(sid('same'), { predecessorId: sid('same'), successorId: sid('same') }))
      .toBeUndefined()
  })
})

describe('persisted target', () => {
  it('round-trips one id and ignores anything unusable', () => {
    expect(parsePersistedTarget(serializeTarget(sid('session-abc-def')))).toBe('session-abc-def')
    expect(parsePersistedTarget(undefined)).toBeUndefined()
    expect(parsePersistedTarget('   ')).toBeUndefined()
    // A hand-edited or corrupt file must fall back to the configured target
    // rather than take the driver down.
    expect(parsePersistedTarget('{"id":"session-1"}')).toBeUndefined()
  })
})
