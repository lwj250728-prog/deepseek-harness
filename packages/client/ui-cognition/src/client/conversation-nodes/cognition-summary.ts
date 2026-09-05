/**
 * Completed-turn cognition bubble: the engine-owned Chat node that renders the
 * pipeline's per-turn cognition activity (new experiences, citation settlement,
 * resolved predictions) from the host's `cognition/turn-summary` event. The
 * event is UI-only and fires only when the turn produced activity, so a quiet
 * turn has no Context and no bubble. The event type is asserted structurally —
 * the client never declares the host's session vocabulary.
 * @module dsh-client-ui-cognition/conversation-nodes/cognition-summary
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  ChatConversationViewNode,
  ConversationNodeContext,
  ConversationNodeDefinition,
  ConversationViewNode,
} from '@deepseek-ai/dsh-client-runtime/client'

/** Wire shape of the host's turn cognition summary (mirrors the session event). */
export interface TurnCognitionSummaryWire {
  readonly turn: number
  readonly newExperiences: readonly { expId: string; topic: string }[]
  readonly citationSettlement: { readonly settled: number; readonly cited: number }
  readonly resolvedPredictions: number
}

/** Renderer payload: the summary plus its durable coordinates. */
export interface CognitionSummaryChatData {
  readonly turn: number
  readonly seq: number
  readonly time: number
  readonly summary: TurnCognitionSummaryWire
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** Per-turn cognition bubble data. */
    'cognition-summary': CognitionSummaryChatData
  }
}

/** Structural narrowing of the host event, independent of the session union. */
interface SummaryEvent {
  readonly type: 'cognition/turn-summary'
  readonly seq: number
  readonly time: number
  readonly data: TurnCognitionSummaryWire
}

/** Narrow one raw session event to the owned summary shape, or undefined. */
function asSummaryEvent(event: { type: string }): SummaryEvent | undefined {
  if (event.type !== 'cognition/turn-summary') return undefined
  return event as unknown as SummaryEvent
}

interface CognitionSummaryState {
  readonly turn: number
  readonly event?: SummaryEvent
}

/** Resolve the context's summary event, tolerating an update-before-start edge. */
function summaryEvent(context: ConversationNodeContext<CognitionSummaryState>): SummaryEvent | undefined {
  if (context.state?.event !== undefined) return context.state.event
  for (const match of context.matches) {
    const narrowed = asSummaryEvent(match.event)
    if (narrowed !== undefined) return narrowed
  }
  return undefined
}

/**
 * One Cognition bubble per completed turn: starts on the host's
 * `cognition/turn-summary` event (published only when the turn had activity)
 * and renders as a chat node anchored at the event's sequence.
 */
export const cognitionSummaryDefinition: ConversationNodeDefinition<CognitionSummaryState> = {
  kind: 'cognition-summary',
  target: 'chat',
  match: (event) => {
    const narrowed = asSummaryEvent(event)
    if (narrowed === undefined) return null
    return { id: String(narrowed.data.turn), role: 'start' }
  },
  start: (_context, match) => {
    const narrowed = asSummaryEvent(match.event)
    return {
      turn: narrowed?.data.turn ?? 0,
      ...(narrowed === undefined ? {} : { event: narrowed }),
    }
  },
  update: (context, match) => {
    const narrowed = asSummaryEvent(match.event)
    return narrowed === undefined
      ? context.state
      : { ...context.state, event: narrowed }
  },
  publication: () => 'immediate',
  buildViewNode: (context): ConversationViewNode | null => {
    const event = summaryEvent(context)
    if (event === undefined) return null
    const location = context.start?.location ?? context.matches[0]?.location
    if (location === undefined) return null
    const node: ChatConversationViewNode = {
      key: context.key,
      kind: 'cognition-summary',
      id: context.id,
      target: 'chat',
      anchorSeq: event.seq,
      location,
      visibility: 'visible',
      data: {
        turn: event.data.turn,
        seq: event.seq,
        time: event.time,
        summary: event.data,
      } satisfies CognitionSummaryChatData,
    }
    return node
  },
}

/**
 * Register the cognition bubble's Chat node contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerCognitionSummaryNode(ctx: Context): void {
  ctx.conversationEvents.register(cognitionSummaryDefinition)
}
