/**
 * Target binding for the quiet driver.
 *
 * The driver wakes one configured target session. Sessions can now hand their
 * conversation to a successor (the `session-handover` plugin, at a compaction
 * boundary), so a driver holding a fixed id would keep waking a session nobody
 * is in — its three-question frames would land in an archived predecessor
 * forever. Rebinding is therefore part of "the conversation moved", not an
 * extra feature.
 *
 * The binding is persisted beside the driver's own frame log so a restart does
 * not snap the target back to the profile's now-stale id: the profile names the
 * session the mechanism STARTED on, and the file names where that conversation
 * actually is now.
 *
 * @module @deepseek-ai/dsh-quiet-driver/target-binding
 */

import type { SessionId } from '@deepseek-ai/dsh-session'

/** The subset of a handover notice this module needs. */
export interface HandoverNotice {
  readonly predecessorId: SessionId
  readonly successorId: SessionId
}

/**
 * The target to use after one handover, or `undefined` when it is unrelated.
 * @param current - the session the driver is waking right now.
 * @param notice - the handover that just happened.
 * @returns the successor id when the driver was following the predecessor.
 */
export function rebindTarget(current: SessionId, notice: HandoverNotice): SessionId | undefined {
  if (notice.predecessorId !== current) return undefined
  if (notice.successorId === current) return undefined
  return notice.successorId
}

/**
 * Read one persisted target id.
 * @param text - the file's contents, or undefined when it does not exist yet.
 * @returns the stored id, or undefined when the file is absent or unusable.
 */
export function parsePersistedTarget(text: string | undefined): SessionId | undefined {
  const trimmed = text?.trim()
  if (trimmed === undefined || trimmed.length === 0) return undefined
  // One id per file, no JSON: a corrupt or hand-edited file must fall back to
  // the configured target rather than taking the driver down.
  if (!/^[A-Za-z0-9._:-]+$/u.test(trimmed)) return undefined
  return trimmed as SessionId
}

/**
 * Serialize one target id for persistence.
 * @param id - the session the driver should wake from now on.
 * @returns the file contents.
 */
export function serializeTarget(id: SessionId): string {
  return `${String(id)}\n`
}
