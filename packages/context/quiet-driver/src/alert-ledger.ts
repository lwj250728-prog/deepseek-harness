/**
 * Alert-ledger helpers shared by every watchdog alert path (cl-109).
 *
 * Two defects kept recurring because each alert path re-implemented them:
 *   · **Date**: `toISOString()` is UTC — a local 00:00–07:59 alert writes
 *     yesterday's date into `reviewBy`, so the alert is "already overdue" the
 *     moment it lands (the suite's T33 flags it that same day).
 *   · **Idempotence**: alerts are *condition*-keyed, not *event*-keyed, but the
 *     in-memory handle resets on restart — a condition that persists across a
 *     restart (or a date rollover) opens a second alert for the same problem.
 *
 * Extracted here as pure functions so the logic is testable without waiting for
 * a real stall/expiry to happen (see tp-071/T89).
 * @module @deepseek-ai/dsh-quiet-driver/alert-ledger
 */

/** The local calendar day (`YYYY-MM-DD`), optionally offset by whole days.
 * @param plusDays - days to add to today.
 * @param from - reference instant (defaults to now).
 * @returns the local calendar date, never the UTC one.
 */
export function localDay(plusDays = 0, from: Date = new Date()): string {
  const shifted = new Date(from.getTime() + plusDays * 24 * 60 * 60 * 1000)
  return new Date(shifted.getTime() - shifted.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

/**
 * Find the id of the still-open alert for one condition family, reading an
 * append-only claims ledger with last-wins semantics per id (cl-041).
 * @param rawLedger - the ledger's raw text (jsonl, possibly with bad lines).
 * @param prefix - the alert id prefix, e.g. `cl-stall-`.
 * @returns the open alert's id, or null when every alert of that family is closed.
 */
export function findOpenAlertId(rawLedger: string, prefix: string): string | null {
  const statusById = new Map<string, string>()
  for (const line of rawLedger.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      const record = JSON.parse(line) as { id?: unknown, status?: unknown }
      if (typeof record.id !== 'string' || !record.id.startsWith(prefix)) continue
      statusById.set(record.id, String(record.status ?? ''))  // last write wins
    } catch { /* malformed line: skip, never fail the caller */ }
  }
  for (const [id, status] of statusById) if (status === 'open') return id
  return null
}
