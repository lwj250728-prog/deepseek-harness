/**
 * life domain contract: the digital-life overview surface. The browser's
 * life stream (state card + trace timeline + designated-session pin) reads
 * one aggregated overview instead of reaching into chain/trace files. The
 * domain is read-only; mutation stays with the situational-state plugin
 * (situational_state_commit) and its turn-end/compaction write-backs.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** Wire projection of the situational chain head (the life's current state). */
export interface LifeChainHead {
  readonly nodeId: string
  readonly seq: number
  /** The committed situation summary. */
  readonly situation: string
  /** The session that committed this state (the current life owner). */
  readonly sessionId: string
  /** Epoch milliseconds at commit. */
  readonly createdAt: number
}

/** One wire trace entry of the life timeline (inject or commit). */
export interface LifeTraceEntry {
  readonly traceId: string
  readonly kind: 'inject' | 'commit'
  readonly nodeId: string
  readonly sessionId: string
  readonly situation: string
  readonly createdAt: number
  /** Session position when recorded. */
  readonly position?: string
  /** Commit provenance ('tool' | 'bootstrap' | 'turn-end' | 'compaction'). */
  readonly origin?: string
}

/**
 * Life-domain unary methods. Read-only: the overview aggregates host state
 * the situational-state plugin already persists.
 */
export interface LifeApi {
  /** The life overview: current chain head (null when the chain is empty),
   * the newest trace entries, and the designated session — v1 the session
   * owning the current head. */
  overview(request: RpcRequest<Record<string, never>>):
  Promise<RpcResponse<{
    chainHead: LifeChainHead | null
    traceTail: readonly LifeTraceEntry[]
    designatedSessionId: string | null
  }>>
}
