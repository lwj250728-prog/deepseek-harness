import { memo, useState } from 'react'
import { IconChevronDownOutline14, IconChevronRightOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { CognitionSummaryChatData } from './conversation-nodes/cognition-summary.ts'
import css from './CognitionSummary.module.css'

/**
 * Renderer props: the engine-owned node (its `data` carries the summary) plus
 * the cognition locale seat. Registered under the conversation.chat.node key.
 */
export interface CognitionSummaryNodeViewProps {
  readonly node: { readonly data: CognitionSummaryChatData }
  readonly t: PropsLocale<'cognition'>['t']
}

/** The per-turn cognition bubble: counts on one line, expId/topic detail on expand. */
export const CognitionSummaryNodeView = memo(function CognitionSummaryNodeView({
  node,
  t,
}: CognitionSummaryNodeViewProps) {
  const [open, setOpen] = useState(false)
  const summary = node.data.summary
  const experienceCount = summary.newExperiences.length
  return (
    <div className={css.root} data-cognition-summary={summary.turn}>
      <button
        type="button"
        className={css.toggle}
        aria-expanded={open}
        aria-label={open ? t('bubble.collapse.aria') : t('bubble.expand.aria')}
        onClick={() => { setOpen(!open) }}
      >
        {open
          ? <IconChevronDownOutline14 className={css.chevron} />
          : <IconChevronRightOutline14 className={css.chevron} />}
        <span className={css.title}>{t('bubble.title')}</span>
        <span className={css.counts}>
          {t('bubble.experiences', { count: experienceCount })}
          <span className={css.separator}>·</span>
          {t('bubble.citations', { cited: summary.citationSettlement.cited, settled: summary.citationSettlement.settled })}
          <span className={css.separator}>·</span>
          {t('bubble.resolved', { count: summary.resolvedPredictions })}
        </span>
      </button>
      {open ? (
        <ul className={css.detail} aria-label={t('bubble.title')}>
          {summary.newExperiences.map(experience => (
            <li key={experience.expId} className={css.detailRow}>
              <span className={css.expId}>{experience.expId}</span>
              <span className={css.topic}>{experience.topic}</span>
            </li>
          ))}
          {experienceCount === 0 ? <li className={css.detailRow}>{t('bubble.empty.detail')}</li> : null}
        </ul>
      ) : null}
    </div>
  )
})
