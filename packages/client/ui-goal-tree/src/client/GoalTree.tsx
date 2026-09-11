/**
 * Goal trajectory panel, browser half: the `sidebar.footer.action` occupant —
 * a foot trigger plus a floating panel rendering every goal as a compact tree in
 * three lanes (已完成 / 执行中 / 规划).
 *
 * Data arrives on demand through the `trajectory/overview` endpoint on the
 * plugin's own `/goal-tree` RPC channel: the first open fetches once, the
 * refresh button re-runs the generator and re-fetches, and nothing polls. The
 * panel is dense by design — this is a trajectory tree, not a report.
 */
import { useEffect, useMemo, useState } from 'react'
import { clsx } from 'clsx'
import { StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GoalStep, GoalStepKind, GoalTrajectoryGoal } from './contract/goal-trajectory.ts'
import type { GoalTreeProps } from './contract/slots.ts'
import css from './GoalTree.module.css'

/** One lane section: its key and the goals whose current work sits in it. */
interface LaneSection {
  readonly lane: GoalStepKind
  readonly goals: readonly GoalTrajectoryGoal[]
}

/** Per-lane presentation: the label key and the state dot that fronts the section. */
const LANE_VIEW: Record<GoalStepKind, { label: 'lane.completed' | 'lane.executing' | 'lane.planned' | 'lane.blocked'; dot: StateDotState }> = {
  completed: { label: 'lane.completed', dot: 'done' },
  executing: { label: 'lane.executing', dot: 'ongoing' },
  planned: { label: 'lane.planned', dot: 'warning' },
  blocked: { label: 'lane.blocked', dot: 'error' },
}

/** Lane render order: finished work first, then live work, then what is queued. */
const LANE_ORDER: readonly GoalStepKind[] = ['completed', 'executing', 'planned', 'blocked']

/** Does one goal hold any step in this lane? */
function holdsLane(goal: GoalTrajectoryGoal, lane: GoalStepKind): boolean {
  return goal.counts[lane] > 0
}

/**
 * Group goals into lane sections. A goal appears under the lane of its current
 * work — its own `lane` — and under every other lane it still holds steps in, so
 * the badges above a goal row and the sections it appears in cannot disagree.
 */
function groupLanes(goals: readonly GoalTrajectoryGoal[]): readonly LaneSection[] {
  return LANE_ORDER.map(lane => ({
    lane,
    goals: goals.filter(goal => (lane === goal.lane ? true : holdsLane(goal, lane))),
  }))
}

/** `2026-09-11T09:44:12` → `09:44`; anything unexpected passes through unchanged. */
function clockOf(ts: string): string {
  const match = /T(\d{2}:\d{2})/.exec(ts)
  return match === null ? ts : match[1] as string
}

/** Coarse staleness of the snapshot against the browser clock. */
function ageOf(generatedAt: string, now: number, t: GoalTreeProps['t']): string {
  const parsed = Date.parse(generatedAt)
  if (Number.isNaN(parsed)) return generatedAt
  const minutes = Math.floor(Math.max(0, now - parsed) / 60_000)
  if (minutes < 1) return t('panel.justNow')
  if (minutes < 60) return t('panel.minutesAgo', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('panel.hoursAgo', { count: hours })
  return t('panel.daysAgo', { count: Math.floor(hours / 24) })
}

/**
 * Render the panel. The trigger stays visible in both sidebar widths; the panel
 * itself is anchored beside the user's sidebar edge so it does not depend on the
 * owner's column geometry.
 */
export function GoalTree({ wide, useStore, actions, refresh, t }: GoalTreeProps) {
  const status = useStore(s => s.status)
  const overview = useStore(s => s.overview)
  const error = useStore(s => s.error)
  const open = useStore(s => s.open)
  const expanded = useStore(s => s.expanded)
  const [openStep, setOpenStep] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // Fetch on the first open, then re-stamp the staleness label once a minute
  // for as long as the panel is open (no network activity).
  useEffect(() => {
    if (!open) return
    if (status === 'idle') {
      const controller = new AbortController()
      void refresh(controller.signal)
      return () => { controller.abort() }
    }
    const timer = setInterval(() => { setNow(Date.now()) }, 60_000)
    return () => { clearInterval(timer) }
  }, [open, status, refresh])

  const goals = overview?.snapshot.goals ?? []
  const lanes = useMemo(() => groupLanes(goals), [goals])
  const goalCount = goals.length

  return (
    <>
      <button
        type="button"
        className={clsx(css.trigger, open && css.triggerActive)}
        aria-label={t('panel.toggle.aria')}
        aria-expanded={open}
        title={t('panel.label')}
        onClick={() => { actions.setOpen(!open) }}
      >
        <TreeGlyph className={css.triggerGlyph} />
        {wide && <span className={css.triggerLabel}>{t('panel.label')}</span>}
        {overview !== null && <span className={css.triggerCount}>{goalCount}</span>}
      </button>

      {open && (
        <section className={css.panel} aria-label={t('panel.label')}>
          <header className={css.header}>
            <TreeGlyph className={css.headerGlyph} />
            <span className={css.headerTitle}>{t('panel.label')}</span>
            <span className={css.headerCount}>{t('panel.count', { count: goalCount })}</span>
            <button
              type="button"
              className={css.iconButton}
              aria-label={t('panel.refresh.aria')}
              disabled={status === 'loading'}
              onClick={() => {
                const controller = new AbortController()
                void refresh(controller.signal, true)
              }}
            >
              ↻
            </button>
            <button
              type="button"
              className={css.iconButton}
              aria-label={t('panel.close.aria')}
              onClick={() => { actions.setOpen(false) }}
            >
              ✕
            </button>
          </header>

          {overview !== null && (
            <div className={css.subheader}>
              <span>{t('panel.generated', { time: ageOf(overview.snapshot.generatedAt, now, t) })}</span>
              {overview.regenerated && <span className={css.regenerated}>↻</span>}
            </div>
          )}

          <div className={css.body}>
            {status === 'error'
              ? <div className={css.error}>{t('panel.error')}：{error}</div>
              : overview === null
                ? <div className={css.empty}>{status === 'loading' ? '…' : t('panel.empty')}</div>
                : (
                  <>
                    {lanes.map(section => section.goals.length === 0 ? null : (
                      <div key={section.lane} className={css.lane} data-lane={section.lane}>
                        <div className={css.laneHead}>
                          <StateDot state={LANE_VIEW[section.lane].dot} />
                          <span>{t(LANE_VIEW[section.lane].label)}</span>
                          <span className={css.laneCount}>{section.goals.length}</span>
                        </div>
                        {section.goals.map(goal => (
                          <GoalRow
                            key={`${section.lane}:${goal.id}`}
                            goal={goal}
                            lane={section.lane}
                            expanded={expanded.includes(goal.id)}
                            openStep={openStep}
                            onToggle={() => { actions.toggleGoal(goal.id) }}
                            onToggleStep={stepId => { setOpenStep(current => (current === stepId ? null : stepId)) }}
                            t={t}
                          />
                        ))}
                      </div>
                    ))}
                  </>
                )}
          </div>
        </section>
      )}
    </>
  )
}

/** Props of one goal row inside a lane section. */
interface GoalRowProps {
  readonly goal: GoalTrajectoryGoal
  readonly lane: GoalStepKind
  readonly expanded: boolean
  readonly openStep: string | null
  readonly onToggle: () => void
  readonly onToggleStep: (stepId: string) => void
  readonly t: GoalTreeProps['t']
}

/** One goal row: title, lane badge, the three counts, meta, and its step list. */
function GoalRow({ goal, lane, expanded, openStep, onToggle, onToggleStep, t }: GoalRowProps) {
  return (
    <div className={css.goal} data-expanded={expanded}>
      <button
        type="button"
        className={css.goalHead}
        aria-expanded={expanded}
        aria-label={t('goal.expand.aria')}
        onClick={onToggle}
      >
        <span className={css.caret} aria-hidden>{expanded ? '▾' : '▸'}</span>
        <span className={css.goalTitle} title={goal.title}>{goal.title}</span>
      </button>

      <div className={css.badges}>
        <span className={css.laneBadge} data-lane={lane}>{t(LANE_VIEW[lane].label)}</span>
        <span className={css.statusBadge}>{goal.status}</span>
        {goal.waiting && <span className={css.waitingBadge}>{t('goal.waiting')}</span>}
        <span className={css.counts}>
          {t('goal.counts', {
            completed: goal.counts.completed,
            executing: goal.counts.executing,
            planned: goal.counts.planned,
          })}
        </span>
        <span className={css.meta}>{t('goal.wakes', { count: goal.wakes })}</span>
        <span className={css.meta}>{t('goal.adopted', { count: goal.adopted })}</span>
        <span className={css.meta}>{clockOf(goal.lastActionAt)}</span>
        <span className={css.meta}>{t('goal.steps', { count: goal.steps.length })}</span>
      </div>

      {goal.nextAction.length > 0 && (
        <div className={css.nextAction} title={goal.nextAction}>
          <span className={css.nextLabel}>{t('goal.next')}</span>
          {goal.nextAction}
        </div>
      )}

      {expanded && (
        <ol className={css.steps}>
          {goal.steps.map(step => (
            <StepRow
              key={step.id}
              step={step}
              open={openStep === step.id}
              onToggle={() => { onToggleStep(step.id) }}
              t={t}
            />
          ))}
        </ol>
      )}
    </div>
  )
}

/** Props of one step row. */
interface StepRowProps {
  readonly step: GoalStep
  readonly open: boolean
  readonly onToggle: () => void
  readonly t: GoalTreeProps['t']
}

/** One ledger step: id, kind badge, timestamp, claim text, and expandable evidence. */
function StepRow({ step, open, onToggle, t }: StepRowProps) {
  return (
    <li className={css.step} data-kind={step.kind} data-open={open}>
      <button
        type="button"
        className={css.stepHead}
        aria-expanded={open}
        title={step.claim}
        onClick={onToggle}
      >
        <span className={css.stepId}>{step.id}</span>
        <span className={css.stepKind} data-kind={step.kind}>{step.kind.slice(0, 4)}</span>
        <span className={css.stepTime}>{clockOf(step.ts)}</span>
        <span className={css.stepClaim}>{step.claim}</span>
      </button>
      {open && (
        <div className={css.stepDetail}>
          <div className={css.stepDetailRow}>
            <span className={css.stepDetailLabel}>{step.status}</span>
            {step.reviewBy !== null && <span className={css.stepDetailLabel}>{t('step.reviewBy', { date: step.reviewBy })}</span>}
          </div>
          <div className={css.stepClaimFull}>{step.claim}</div>
          <div className={css.evidenceLabel}>{t('step.evidence')}</div>
          <div className={css.evidence}>
            {step.evidence.length > 0 ? step.evidence : t('step.noevidence')}
          </div>
        </div>
      )}
    </li>
  )
}

/** The panel's mark: three lanes branching off one trunk. */
function TreeGlyph({ className }: { className?: string | undefined }): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" className={className} aria-hidden>
      <path
        d="M3 2v12M3 5h5M3 8h7M3 11h5"
        fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"
      />
      <circle cx="10" cy="5" r="1.3" fill="currentColor" />
      <circle cx="12" cy="8" r="1.3" fill="currentColor" />
      <circle cx="10" cy="11" r="1.3" fill="currentColor" />
    </svg>
  )
}
