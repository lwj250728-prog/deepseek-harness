/**
 * Digital-life strip, browser half: the sidebar `sidebar.life` occupant
 * rendering the main conversation's current state (chain head) and its recent
 * situational trajectory. Data arrives on demand through the `life.overview`
 * RPC (fetch on mount/expand, manual refresh) — read-only, like the learning
 * area. Collapsed to the sidebar rail it becomes a lone life icon.
 */
import { useEffect } from 'react'
import type { LifeStripProps } from './contract/slots.ts'
import { ageLabel } from './life-age.ts'
import css from './LifeStrip.module.css'

/** Origin badge vocabulary: trace origin code → locale key suffix. */
const ORIGIN_KEY: Record<string, string> = {
  tool: 'life.origin.tool',
  bootstrap: 'life.origin.bootstrap',
  'turn-end': 'life.origin.turn-end',
  compaction: 'life.origin.compaction',
}

/** One trace row label: kind word + optional origin badge + node + age. */
function traceRowText(entry: { kind: 'inject' | 'commit'; origin?: string }, t: LifeStripProps['t']): string {
  const kind = entry.kind === 'inject' ? t('life.kind.inject') : t('life.kind.commit')
  const originKey = entry.origin === undefined ? undefined : ORIGIN_KEY[entry.origin]
  return originKey === undefined ? kind : `${kind} · ${t(originKey as 'life.origin.tool')}`
}

/**
 * Render the life strip. Wide: the state card (head situation with age and
 * owner session, a 主对话 badge when the owner is the designated session)
 * above the trace timeline; a refresh button re-fetches. Rail: a lone
 * trigger that expands the column on click (the strip body stays hidden).
 */
export function LifeStrip({ wide, expandSidebar, useStore, actions, refresh, t }: LifeStripProps) {
  const status = useStore(s => s.status)
  const head = useStore(s => s.head)
  const trace = useStore(s => s.trace)
  const designated = useStore(s => s.designatedSessionId)
  const error = useStore(s => s.error)
  const expanded = useStore(s => s.expanded)

  // Fetch on first mount (wide content mounts when the column expands).
  useEffect(() => {
    if (status !== 'idle') return
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => { controller.abort() }
  }, [status, refresh])

  if (!wide) {
    return (
      <button
        type="button"
        className={css.railTrigger}
        aria-label={t('life.toggle.aria')}
        onClick={() => { expandSidebar() }}
      >
        <LifeGlyph />
      </button>
    )
  }

  return (
    <section className={css.root} aria-label={t('life.label')}>
      <div className={css.header}>
        <button
          type="button"
          className={css.heading}
          aria-expanded={expanded}
          onClick={() => { actions.setExpanded(!expanded) }}
        >
          <LifeGlyph className={css.headingGlyph} />
          <span>{t('life.label')}</span>
        </button>
        <button
          type="button"
          className={css.refresh}
          aria-label={t('life.refresh.aria')}
          disabled={status === 'loading'}
          onClick={() => {
            const controller = new AbortController()
            void refresh(controller.signal)
          }}
        >
          ↻
        </button>
      </div>

      {expanded && (
        <div className={css.body}>
          {status === 'error'
            ? <div className={css.error}>{t('error.load')}：{error}</div>
            : head === null && trace.length === 0
              ? <div className={css.empty}>{t('life.empty')}</div>
              : (
                <>
                  {head !== null && (
                    <div className={css.stateCard}>
                      <div className={css.stateText}>{head.situation}</div>
                      <div className={css.stateMeta}>
                        <span>{t('life.age', { age: ageLabel(head.createdAt) })}</span>
                        {head.sessionId.length > 0 && (
                          <span>{t('life.owner', { session: head.sessionId.slice(0, 12) })}</span>
                        )}
                        {designated !== null && head.sessionId === designated && (
                          <span className={css.designatedBadge}>{t('life.designated')}</span>
                        )}
                      </div>
                    </div>
                  )}
                  {trace.length > 0 && (
                    <ol className={css.trace}>
                      {trace.map(entry => (
                        <li key={entry.traceId} className={css.traceRow} data-kind={entry.kind}>
                          <span className={css.traceDot} aria-hidden />
                          <span className={css.traceWord}>
                            {traceRowText(entry, t)} <span className={css.traceNode}>{entry.nodeId}</span>
                          </span>
                          <span className={css.traceAge}>{ageLabel(entry.createdAt)}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                </>
              )}
        </div>
      )}
    </section>
  )
}

/** The life glyph: a small pulse/thread mark. */
function LifeGlyph({ className }: { className?: string | undefined }): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" className={className} aria-hidden>
      <path
        d="M2 8c2 0 2-4 4-4s2 8 4 8 2-4 4-4"
        fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
      />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" />
    </svg>
  )
}
