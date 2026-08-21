/**
 * Session-ledger tool-call evidence: the non-self-referential witness for
 * claim audits. Reading the harness-written log means the verdict about what
 * a tool call actually did comes from the ledger, never from the model's
 * memory of the call.
 * @module @deepseek-ai/dsh-cognitive-pipeline/log-evidence
 */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/** One mechanically-verified tool-call fact from the session ledger. */
export interface ToolCallEvidence {
  /** The matched `tool/call` event's call id. */
  readonly callId: string
  /** Whether the matched `tool/result` carried no error flag. */
  readonly succeeded: boolean
}

/**
 * Locate the most recent `tool/call` with the given name in the session ledger
 * and read its terminal result. This is the non-self-referential witness for
 * claim audits: the verdict comes from the harness-written log, never from the
 * model's memory of the call. A call whose result is still pending (or that
 * never happened) resolves to null.
 * @param session - the session whose ledger holds the tool events.
 * @param toolName - the tool name to match; the most recent call wins.
 * @returns the call id and success flag, or null when no settled matching call exists.
 */
export function findToolCallEvidence(session: Session, toolName: string): ToolCallEvidence | null {
  const events = session.events as readonly SessionEvent[]
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'tool/call') continue
    const call = event.data as { name?: unknown; callId?: unknown }
    if (typeof call.name !== 'string' || call.name !== toolName) continue
    const callId = typeof call.callId === 'string' ? call.callId : ''
    for (let resultIndex = index + 1; resultIndex < events.length; resultIndex += 1) {
      const resultEvent = events[resultIndex]
      if (resultEvent === undefined || resultEvent.type !== 'tool/result') continue
      const result = resultEvent.data as {
        message?: {
          source?: { callId?: unknown }
          content?: readonly ({ isError?: boolean; toolCallId?: unknown } | undefined)[]
        }
      }
      const message = result.message
      if (message === undefined) return null
      // The tool/result message's call id lives on the source envelope, and the
      // error flag on the tool-result content block (not on `message` itself) —
      // the same payload shape reconstructTurn reads (per exp_58's fix).
      const sourceCallId = message.source?.callId
      const blockCallId = (message.content?.[0] as { toolCallId?: unknown } | undefined)?.toolCallId
      if (callId !== '' && sourceCallId !== callId && blockCallId !== callId) continue
      const failed = message.content?.some(block => block?.isError === true) === true
      return { callId, succeeded: !failed }
    }
    return null
  }
  return null
}
