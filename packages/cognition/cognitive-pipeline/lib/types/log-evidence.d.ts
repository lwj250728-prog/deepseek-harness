/**
 * Session-ledger tool-call evidence: the non-self-referential witness for
 * claim audits. Reading the harness-written log means the verdict about what
 * a tool call actually did comes from the ledger, never from the model's
 * memory of the call.
 * @module @deepseek-ai/dsh-cognitive-pipeline/log-evidence
 */
import type { Session } from '@deepseek-ai/dsh-session';
/** One mechanically-verified tool-call fact from the session ledger. */
export interface ToolCallEvidence {
    /** The matched `tool/call` event's call id. */
    readonly callId: string;
    /** Whether the matched `tool/result` carried no error flag. */
    readonly succeeded: boolean;
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
export declare function findToolCallEvidence(session: Session, toolName: string): ToolCallEvidence | null;
//# sourceMappingURL=log-evidence.d.ts.map