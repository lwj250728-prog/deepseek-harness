import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import {
  IconChevronDownOutline14, IconChevronRightOutline14, IconListPenOutline16,
  IconRefreshOutline14, StateDot, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { LearningAreaProps } from './contract/slots.ts'
import type { ExplorationTaskStatus, ExplorationTaskView } from './contract/slots.ts'
import type { LearningFilter } from './contract/slots.ts'
import css from './LearningArea.module.css'

/** Closed-union exhaustiveness fence for the wire status set. */
/* v8 ignore next 3 -- closed-union backstop; only reached if a status is forged */
function assertNever(value: never): never {
  throw new Error(`unhandled exploration status: ${JSON.stringify(value)}`)
}

/** Status marker semantics: only in-flight learning draws attention. */
function dotState(status: ExplorationTaskStatus): StateDotState {
  switch (status) {
    case 'running': return 'ongoing'
    case 'pending': return 'warning'
    case 'completed': return 'done'
    case 'failed': return 'error'
    /* v8 ignore next -- closed wire status union */
    default: return assertNever(status)
  }
}

/** Rank for the status-ordered list: running first, pending next, settled last. */
function rankOf(status: ExplorationTaskStatus): number {
  switch (status) {
    case 'running': return 0
    case 'pending': return 1
    case 'completed': return 2
    case 'failed': return 3
    /* v8 ignore next -- closed wire status union */
    default: return assertNever(status)
  }
}

/** Sort: status order, then newest-first by creation. */
function ordered(tasks: readonly ExplorationTaskView[]): ExplorationTaskView[] {
  return [...tasks].sort((left, right) => {
    const rankDiff = rankOf(left.status) - rankOf(right.status)
    if (rankDiff !== 0) return rankDiff
    return right.createdAt - left.createdAt
  })
}

/** All filters the UI offers, in display order. */
const FILTERS: readonly LearningFilter[] = ['all', 'pending', 'running', 'completed', 'failed']

/**
 * The learning area: a collapsible sidebar section listing the cognitive
 * pipeline's exploration tasks. Fetch-on-open plus a manual refresh — no
 * polling, so an idle browser costs nothing.
 * @param props - runtime + store shares, the inject fetch face, and locale.
 * @returns the collapsible section, or a rail trigger while collapsed.
 */
export function LearningArea({
  wide,
  expandSidebar,
  useStore,
  actions,
  refresh,
  t,
}: LearningAreaProps) {
  const status = useStore(state => state.status)
  const tasks = useStore(state => state.tasks)
  const counts = useStore(state => state.counts)
  const filter = useStore(state => state.filter)
  const expanded = useStore(state => state.expanded)

  // A fetch on first expand; the inject face owns the wire and the store
  // transition, so the component only asks once per open.
  const [asked, setAsked] = useState(false)
  useEffect(() => {
    if (!wide || !expanded || asked) return
    setAsked(true)
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => { controller.abort() }
  }, [wide, expanded, asked, refresh])

  const rows = useMemo(() => ordered(tasks), [tasks])
  const filtered = filter === 'all' ? rows : rows.filter(task => task.status === filter)
  const runningCount = counts.running
  const totalCount = tasks.length

  // Rail state: an icon trigger that expands the column.
  if (!wide) {
    return (
      <button
        type="button"
        className={css.railTrigger}
        aria-label={t('area.label')}
        title={t('area.label')}
        onClick={expandSidebar}
      >
        <IconListPenOutline16 size={18} />
        {runningCount > 0 ? <span className={css.railBadge}>{runningCount}</span> : null}
      </button>
    )
  }

  const isOpen = expanded && (status === 'ready' || status === 'error' || status === 'loading')

  return (
    <section className={css.root} aria-label={t('area.label')}>
      <div className={css.header}>
        <button
          type="button"
          className={css.toggle}
          aria-expanded={isOpen}
          aria-label={t('area.label.expanded', { count: totalCount })}
          onClick={() => { actions.setExpanded(!expanded) }}
        >
          {expanded
            ? <IconChevronDownOutline14 className={css.chevron} />
            : <IconChevronRightOutline14 className={css.chevron} />}
          <IconListPenOutline16 className={css.headerIcon} />
          <span className={css.title}>{t('area.label')}</span>
          {runningCount > 0 ? (
            <span className={css.runningCount} title={t('count.running', { count: runningCount })}>
              {runningCount}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          className={css.refresh}
          aria-label={t('refresh.aria')}
          disabled={status === 'loading'}
          onClick={() => {
            const controller = new AbortController()
            void refresh(controller.signal)
          }}
        >
          <IconRefreshOutline14 className={status === 'loading' ? css.spinning : undefined} />
        </button>
      </div>

      {isOpen ? (
        <div className={css.body}>
          <div className={css.filters} role="group" aria-label={t('list.aria')}>
            {FILTERS.map(candidate => (
              <button
                key={candidate}
                type="button"
                className={clsx(css.filter, filter === candidate && css.filterActive)}
                aria-pressed={filter === candidate}
                onClick={() => { actions.setFilter(candidate) }}
              >
                {t(`filter.${candidate}`)}
                <span className={css.filterCount}>{candidate === 'all' ? totalCount : counts[candidate]}</span>
              </button>
            ))}
          </div>

          {status === 'error' ? <p className={css.note}>{t('error.load')}</p> : null}
          {status !== 'error' && filtered.length === 0 ? (
            <p className={css.note}>{totalCount === 0 ? t('empty') : t('empty.filtered')}</p>
          ) : null}

          <ul className={css.list} aria-label={t('list.aria')}>
            {filtered.map(task => (
              <TaskRow key={task.taskId} task={task} t={t} />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}

/** One task row: status dot, goal, expandable result detail. */
function TaskRow({
  task,
  t,
}: {
  task: ExplorationTaskView
  t: LearningAreaProps['t']
}) {
  const [open, setOpen] = useState(false)
  return (
    <li className={css.row}>
      <button
        type="button"
        className={css.rowToggle}
        aria-expanded={open}
        onClick={() => { setOpen(!open) }}
      >
        <StateDot state={dotState(task.status)} className={css.rowDot} />
        <span className={css.rowGoal} title={task.goal}>{task.goal}</span>
        <span className={css.rowStatus}>{t(`status.${task.status}`)}</span>
      </button>
      {open ? (
        <div className={css.rowDetail}>
          <p className={css.detailLine}><span className={css.detailLabel}>{t('goal.label')}</span>{task.goal}</p>
          <p className={css.detailLine}>
            <span className={css.detailLabel}>{t('result.label')}</span>
            {task.result ?? '—'}
          </p>
          <p className={css.detailLine}>
            <span className={css.detailLabel}>{t('createdAt.label')}</span>
            {new Date(task.createdAt).toLocaleString()}
          </p>
        </div>
      ) : null}
    </li>
  )
}
