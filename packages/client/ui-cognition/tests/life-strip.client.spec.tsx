// @vitest-environment jsdom
// LifeStrip behavior: fetches the life overview on mount, renders the state
// card (chain head) with owner/designated badges and the trace timeline,
// expands/collapses on the heading, and collapses to a rail trigger — driven
// purely through props with a stubbed store and inject face, no wire.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { LifeStripProps } from '../src/client/contract/slots.ts'
import { LifeStrip } from '../src/client/LifeStrip.tsx'
import { createLifeStore } from '../src/client/store.ts'
import { zh } from '../src/client/locales.ts'

const t: LifeStripProps['t'] = makeTranslate(zh, commonZh)

afterEach(cleanup)

function mount(overrides: Partial<LifeStripProps> = {}) {
  const store = createLifeStore().create()
  const refresh = vi.fn<LifeStripProps['refresh']>(async () => {
    store.actions.begin()
    store.actions.replace({
      head: {
        nodeId: 'sstate-3',
        seq: 3,
        situation: '正在推进数字生命路线：主对话自持回路已闭环',
        sessionId: 'session-alpha',
        createdAt: Date.now() - 300_000,
      },
      trace: [
        {
          traceId: 'trace-2', kind: 'commit', nodeId: 'sstate-3', sessionId: 'session-alpha',
          situation: '正在推进数字生命路线：主对话自持回路已闭环', createdAt: Date.now() - 300_000, origin: 'turn-end',
        },
        {
          traceId: 'trace-1', kind: 'inject', nodeId: 'sstate-2', sessionId: 'session-alpha',
          situation: 'M1 交付完成', createdAt: Date.now() - 3_600_000, position: 'seq:42',
        },
      ],
      designatedSessionId: 'session-alpha',
    })
  })
  const props: LifeStripProps = {
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
  const view = render(<LifeStrip {...props} />)
  return { view, props, store, refresh }
}

describe('LifeStrip', () => {
  it('fetches the life overview on mount and renders the state card when expanded', async () => {
    const { refresh } = mount()
    await waitFor(() => { expect(refresh).toHaveBeenCalledTimes(1) })
    fireEvent.click(screen.getByRole('button', { name: '生命' }))
    // The state card carries the chain head's situation.
    expect(await screen.findByText('正在推进数字生命路线：主对话自持回路已闭环')).toBeTruthy()
    // The owner session (id truncated to 12 chars in the meta) and the
    // designated badge are shown.
    expect(screen.getByText(/会话 session/)).toBeTruthy()
    expect(screen.getByText('主对话')).toBeTruthy()
  })

  it('lists the trace rows with kind words and origin badges when expanded', async () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: '生命' }))
    await waitFor(() => { expect(screen.getByText('提交 · 回合末')).toBeTruthy() })
    expect(screen.getByText('注入')).toBeTruthy()
  })

  it('expands and collapses the body through the heading toggle', async () => {
    mount()
    // The body is collapsed by default: the heading exists, the state card is
    // hidden until expanded.
    expect(screen.queryByText('正在推进数字生命路线：主对话自持回路已闭环')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '生命' }))
    expect(await screen.findByText('正在推进数字生命路线：主对话自持回路已闭环')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '生命' }))
    expect(screen.queryByText('正在推进数字生命路线：主对话自持回路已闭环')).toBeNull()
  })

  it('renders a lone rail trigger when the sidebar is collapsed', () => {
    mount({ wide: false })
    expect(screen.getByRole('button', { name: '展开生命条' })).toBeTruthy()
  })

  it('shows the empty hint when the chain has not started', async () => {
    const store = createLifeStore().create()
    const refresh = vi.fn<LifeStripProps['refresh']>(async () => {
      store.actions.begin()
      store.actions.replace({ head: null, trace: [], designatedSessionId: null })
    })
    const props: LifeStripProps = {
      wide: true,
      expandSidebar: vi.fn(),
      useSessions: vi.fn(),
      useWorkspaces: vi.fn(),
      useStore: bindSnapshotSelector(store),
      actions: store.actions,
      refresh,
      t,
    }
    render(<LifeStrip {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '生命' }))
    expect(await screen.findByText(/生命状态链尚未开始/)).toBeTruthy()
  })
})

describe('LifeStrip: fetch lifecycle', () => {
  it('does not abort the request its own begin() just started (慢 RPC)', async () => {
    const signals: AbortSignal[] = []
    const store = createLifeStore().create()
    const slow = vi.fn<LifeStripProps['refresh']>((signal) => {
      store.actions.begin()          // 真实 inject 面就是先 begin() 再发请求
      signals.push(signal)
      return new Promise<void>(() => { /* 一直in flight, 像真实 RPC */ })
    })
    render(<LifeStrip
      wide expandSidebar={vi.fn()} useSessions={vi.fn()} useWorkspaces={vi.fn()}
      useStore={bindSnapshotSelector(store)} actions={store.actions} refresh={slow} t={t}
    />)
    await waitFor(() => { expect(slow).toHaveBeenCalledTimes(1) })
    // 此刻 store 已因 begin() 翻成 loading —— 曾经的 bug 就是这一步 abort 掉自己刚发的请求
    await waitFor(() => { expect(store.getSnapshot().status).toBe('loading') })
    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(false)
  })

  it('加载中不得断言"生命状态链尚未开始"', async () => {
    const store = createLifeStore().create()
    const slow = vi.fn<LifeStripProps['refresh']>((signal) => {
      store.actions.begin()
      void signal
      return new Promise<void>(() => {})
    })
    render(<LifeStrip
      wide expandSidebar={vi.fn()} useSessions={vi.fn()} useWorkspaces={vi.fn()}
      useStore={bindSnapshotSelector(store)} actions={store.actions} refresh={slow} t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: '生命' }))
    await waitFor(() => { expect(store.getSnapshot().status).toBe('loading') })
    expect(screen.queryByText(/生命状态链尚未开始/)).toBeNull()   // 答案没到就不能下结论
  })
})
