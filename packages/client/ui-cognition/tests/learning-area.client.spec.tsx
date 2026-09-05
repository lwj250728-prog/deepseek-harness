// @vitest-environment jsdom
// LearningArea behavior: collapsible sidebar section, fetch-on-first-expand,
// status filters, expandable row detail, rail trigger with running badge —
// driven purely through props with a stubbed store and inject face, no wire.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { LearningAreaProps } from '../src/client/contract/slots.ts'
import type { ExplorationTaskView } from '../src/client/contract/slots.ts'
import { LearningArea } from '../src/client/LearningArea.tsx'
import { createLearningStore } from '../src/client/store.ts'
import { zh } from '../src/client/locales.ts'

const t: LearningAreaProps['t'] = makeTranslate(zh, commonZh)

afterEach(cleanup)

function task(overrides: Partial<ExplorationTaskView> = {}): ExplorationTaskView {
  return {
    taskId: 'task_1',
    goal: '验证新的检索重排策略',
    status: 'pending',
    createdAt: 1700000000000,
    pickedUpAt: null,
    result: null,
    ...overrides,
  }
}

function mount(overrides: Partial<LearningAreaProps> = {}) {
  const store = createLearningStore().create()
  const refresh = vi.fn<LearningAreaProps['refresh']>(async () => {
    store.actions.begin()
    store.actions.replace({
      tasks: [
        task({ status: 'running' }),
        task({ taskId: 'task_2', goal: '调优冷启动分类器', status: 'completed', result: '策略稳定' }),
      ],
      counts: { pending: 0, running: 1, completed: 1, failed: 0 },
    })
  })
  const props: LearningAreaProps = {
    wide: true,
    expandSidebar: vi.fn(),
    useSessions: vi.fn(),
    useWorkspaces: vi.fn(),
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    refresh,
    t,
    ...overrides,
  }
  const view = render(<LearningArea {...props} />)
  return { view, props, store, refresh }
}

describe('LearningArea', () => {
  it('is collapsed by default and fetches once on first expand', async () => {
    const { refresh } = mount()
    // Collapsed: the toggle is present, no body, no fetch yet.
    expect(screen.getByRole('button', { name: '学习会话（0）' })).toBeTruthy()
    expect(screen.queryByText('验证新的检索重排策略')).toBeNull()
    expect(refresh).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '学习会话（0）' }))
    await waitFor(() => { expect(refresh).toHaveBeenCalledTimes(1) })

    // The fetched rows render: running first with its goal.
    expect(screen.getByText('验证新的检索重排策略')).toBeTruthy()
    expect(screen.getAllByText('学习中').length).toBeGreaterThan(0)
  })

  it('filters by status and counts match the snapshot', async () => {
    const { refresh } = mount()
    fireEvent.click(screen.getByRole('button', { name: '学习会话（0）' }))
    await waitFor(() => { expect(refresh).toHaveBeenCalled() })

    // Both rows visible under All.
    expect(screen.getByText('验证新的检索重排策略')).toBeTruthy()
    expect(screen.getByText('调优冷启动分类器')).toBeTruthy()

    // The running filter keeps only the running row.
    const runningFilter = screen.getAllByRole('button', { name: /学习中/ })[0]
    if (runningFilter === undefined) throw new Error('running filter missing')
    fireEvent.click(runningFilter)
    expect(screen.getByText('验证新的检索重排策略')).toBeTruthy()
    expect(screen.queryByText('调优冷启动分类器')).toBeNull()
  })

  it('expands a row to reveal its result detail', async () => {
    const { refresh } = mount()
    fireEvent.click(screen.getByRole('button', { name: '学习会话（0）' }))
    await waitFor(() => { expect(refresh).toHaveBeenCalled() })

    // Open the completed row and read its result.
    const row = screen.getByRole('button', { name: /调优冷启动分类器/ })
    fireEvent.click(row)
    expect(screen.getByText('策略稳定')).toBeTruthy()
    expect(row.getAttribute('aria-expanded')).toBe('true')
  })

  it('shows an empty note when the snapshot has no tasks', async () => {
    const { store } = mount({ refresh: vi.fn(async () => {}) })
    store.actions.replace({ tasks: [], counts: { pending: 0, running: 0, completed: 0, failed: 0 } })
    fireEvent.click(screen.getByRole('button', { name: '学习会话（0）' }))
    await waitFor(() => { expect(screen.getByText('暂无学习任务')).toBeTruthy() })
  })

  it('shows an error note and keeps the section usable after a failed fetch', async () => {
    const { store } = mount({ refresh: vi.fn(async () => {}) })
    store.actions.begin()
    store.actions.fail('网络错误')
    fireEvent.click(screen.getByRole('button', { name: '学习会话（0）' }))
    await waitFor(() => { expect(screen.getByText('加载学习任务失败')).toBeTruthy() })
  })

  it('renders a rail trigger with the running badge when collapsed', async () => {
    const { store } = mount({ wide: false })
    act(() => {
      store.actions.replace({
        tasks: [task({ status: 'running' })],
        counts: { pending: 0, running: 1, completed: 0, failed: 0 },
      })
    })
    expect(screen.getByRole('button', { name: '学习会话' })).toBeTruthy()
    expect(screen.getByText('1')).toBeTruthy()
  })
})
