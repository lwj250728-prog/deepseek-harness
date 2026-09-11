// @vitest-environment jsdom
// The goal-trajectory panel, driven with a real-shaped overview: the three lanes
// must render, each goal must show its counts, and expanding a goal must reveal
// its ledger steps. This is the mechanical check that replaces "nobody can see
// the browser": the user reported an empty panel, and the render path is the
// only part the host-side RPC test could not cover.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useCallback, useMemo, useState } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { GoalTree } from '../src/client/GoalTree.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { GoalTreeActions, GoalTreeState } from '../src/client/contract/slots.ts'
import type { GoalTrajectoryOverview } from '../src/client/contract/goal-trajectory.ts'

afterEach(cleanup)

const OVERVIEW = {
  snapshot: {
    generatedAt: '2026-09-11T10:11:11+08:00',
    source: { goals: '/g', claims: '/c', triggers: '/t' },
    waitingEvaluated: true,
    legend: { completed: 'done', executing: 'running', planned: 'planned', blocked: 'blocked' },
    goals: [
      {
        id: 'goal-retrieval-optimization', title: '检索算法优化', status: 'active',
        lane: 'executing', waiting: false, nextAction: '跑 replay 读可排序集',
        lastActionAt: '2026-09-11T11:42:00', wakes: 203, adopted: 29,
        counts: { completed: 5, executing: 1, planned: 3, blocked: 0 },
        steps: [
          { id: 'cl-218', kind: 'executing', status: 'fixed-awaiting-evidence', ts: '2026-09-11T12:00:00', claim: '效用项接进注入排序', reviewBy: '2026-09-12', evidence: '11/11 顺序改变' },
          { id: 'cl-200', kind: 'completed', status: 'done', ts: '2026-09-11T07:49:00', claim: '样本口径修正', reviewBy: null, evidence: '可排序集 5→30' },
        ],
      },
      {
        id: 'goal-novel-60w', title: '小说完本', status: 'paused',
        lane: 'planned', waiting: false, nextAction: 'ch42 恢复写作',
        lastActionAt: null, wakes: 1, adopted: 1,
        counts: { completed: 3, executing: 1, planned: 0, blocked: 0 },
        steps: [],
      },
    ],
  },
  path: '/home/ubuntu/.dsh/cognitive-pipeline/goal-trajectory.json',
  regenerated: false,
  readAt: 1789113376086,
} as unknown as GoalTrajectoryOverview

/** Selector hook over one frozen state object. */
const useStoreOf = (state: GoalTreeState): SnapshotSelectorHook<GoalTreeState> =>
  ((selector: (s: GoalTreeState) => unknown) => selector(state)) as unknown as SnapshotSelectorHook<GoalTreeState>

const actions = {
  replace: vi.fn(), begin: vi.fn(), fail: vi.fn(), setOpen: vi.fn(), toggleGoal: vi.fn(),
} as unknown as GoalTreeActions

// Faithful `t` double: the real locale service substitutes `{name}` template
// params (locale/src/client/index.ts, `translate`). A stub that drops `params`
// renders `唤醒 {count}` verbatim and invents bugs that do not exist — this one
// keeps the production contract, so a literal placeholder in the DOM is a real
// defect.
const t = ((key: string, params?: Record<string, unknown>) => {
  const template = (zh as Record<string, string>)[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match)
}) as never

describe('goal-trajectory panel', () => {
  it('renders every goal with its lane and counts once the overview is in', () => {
    render(<GoalTree
      wide={false}
      useStore={useStoreOf({ status: 'ready', overview: OVERVIEW, error: null, open: true, expanded: [] })}
      actions={actions}
      refresh={vi.fn()}
      t={t}
    />)
    // 面板会在多处渲染同一标题/编号(列表项 + 展开区), 故用 getAllByText 而不是 getByText
    expect(screen.getAllByText('检索算法优化').length).toBeGreaterThan(0)
    expect(screen.getAllByText('小说完本').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/203/).length).toBeGreaterThan(0)   // wakes
  })

  it('reveals a goal\'s ledger steps when it is expanded', () => {
    render(<GoalTree
      wide={false}
      useStore={useStoreOf({ status: 'ready', overview: OVERVIEW, error: null, open: true, expanded: ['goal-retrieval-optimization'] })}
      actions={actions}
      refresh={vi.fn()}
      t={t}
    />)
    expect(screen.getAllByText('cl-218').length).toBeGreaterThan(0)
    expect(screen.getAllByText('cl-200').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/效用项接进注入排序/).length).toBeGreaterThan(0)
  })

  it('fetches on first open and surfaces a failure instead of staying blank', () => {
    const refresh = vi.fn()
    render(<GoalTree
      wide={false}
      useStore={useStoreOf({ status: 'idle', overview: null, error: null, open: true, expanded: [] })}
      actions={actions}
      refresh={refresh as never}
      t={t}
    />)
    expect(refresh).toHaveBeenCalledTimes(1)

    cleanup()
    render(<GoalTree
      wide={false}
      useStore={useStoreOf({ status: 'error', overview: null, error: 'rpc failed', open: true, expanded: [] })}
      actions={actions}
      refresh={vi.fn()}
      t={t}
    />)
    expect(screen.getByText(/rpc failed/)).toBeTruthy()   // 空面板必须显式报错, 不能静默空白
  })

  it('renders the sidebar trigger label', () => {
    render(<GoalTree
      wide={false}
      useStore={useStoreOf({ status: 'idle', overview: null, error: null, open: false, expanded: [] })}
      actions={actions}
      refresh={vi.fn()}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button'))
    expect(actions.setOpen).toHaveBeenCalled()
  })
})

/**
 * Live-store harness for the fetch effect: the panel gets a store that really
 * transitions `idle → loading` and a refresh face that marks loading before
 * sending — exactly like the real inject face (`actions.begin()` then the RPC).
 * Reproducing that transition is the whole point: it is what used to cancel the
 * request the panel had just sent, which the frozen-state stub cannot express.
 */
function Harness({ probe }: { probe: (signal: AbortSignal, regenerate?: boolean) => Promise<void> }) {
  const [state, setState] = useState<GoalTreeState>({ status: 'idle', overview: null, error: null, open: true, expanded: [] })
  const useStore = useCallback(((selector: (s: GoalTreeState) => unknown) => selector(state)) as never, [state])
  const markLoading = useCallback(() => { setState(s => ({ ...s, status: 'loading' as const })) }, [])
  const liveActions = useMemo(() => ({
    replace: (draft: GoalTreeState, overview: GoalTrajectoryOverview) => setState({ ...draft, status: 'ready' as const, overview, error: null }),
    begin: markLoading,
    fail: (draft: GoalTreeState, message: string) => setState({ ...draft, status: 'error' as const, error: message }),
    setOpen: (draft: GoalTreeState, open: boolean) => setState({ ...draft, open }),
    toggleGoal: (draft: GoalTreeState) => setState({ ...draft }),
  }) as unknown as GoalTreeActions, [markLoading])
  const refresh = useCallback((signal: AbortSignal, regenerate?: boolean) => {
    markLoading()
    return probe(signal, regenerate)
  }, [markLoading, probe])
  return <GoalTree wide={false} useStore={useStore} actions={liveActions} refresh={refresh} t={t} />
}

describe('goal-trajectory panel: fetch lifecycle', () => {
  it('does not abort the request its own begin() just started', async () => {
    const signals: AbortSignal[] = []
    const probe = vi.fn((signal: AbortSignal) => {
      signals.push(signal)
      return new Promise<void>(() => { /* stays in flight, like a slow RPC */ })
    })
    render(<Harness probe={probe} />)
    await waitFor(() => { expect(probe).toHaveBeenCalledTimes(1) })
    // 面板此刻已因 begin() 进入 loading —— 曾经的 bug 就是这一步把请求自己 abort 掉
    await waitFor(() => { expect(screen.getAllByText('…').length).toBeGreaterThan(0) })
    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(false)   // 请求必须仍然在飞, 否则面板永远停在省略号
  })

  it('refetches when reopened after being closed mid-flight', async () => {
    const signals: AbortSignal[] = []
    const probe = vi.fn((signal: AbortSignal) => {
      signals.push(signal)
      return new Promise<void>(() => {})
    })
    const view = render(<Harness probe={probe} />)
    await waitFor(() => { expect(probe).toHaveBeenCalledTimes(1) })
    view.unmount()
    expect(signals[0]?.aborted).toBe(true)   // 卸载/关闭必须真的取消
    render(<Harness probe={probe} />)
    await waitFor(() => { expect(probe).toHaveBeenCalledTimes(2) })
  })
})
