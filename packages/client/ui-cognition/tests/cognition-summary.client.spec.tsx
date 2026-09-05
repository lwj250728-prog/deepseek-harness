// @vitest-environment jsdom
// CognitionSummaryNodeView behavior: the per-turn cognition bubble shows the
// turn's activity counts on one line and the experience details on expand —
// driven purely through props, no wire.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { CognitionSummaryChatData } from '../src/client/conversation-nodes/cognition-summary.ts'
import { CognitionSummaryNodeView } from '../src/client/CognitionSummaryNodeView.tsx'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh, commonZh)

afterEach(cleanup)

function data(overrides: Partial<CognitionSummaryChatData['summary']> = {}): CognitionSummaryChatData {
  return {
    turn: 3,
    seq: 42,
    time: 1700000000000,
    summary: {
      turn: 3,
      newExperiences: [
        { expId: 'exp_208', topic: '快照测试并发超时定位' },
      ],
      citationSettlement: { settled: 5, cited: 2 },
      resolvedPredictions: 1,
      ...overrides,
    },
  }
}

describe('CognitionSummaryNodeView', () => {
  it('renders the activity counts on one line', () => {
    render(<CognitionSummaryNodeView node={{ data: data() }} t={t} />)
    expect(screen.getByText('本回合认知沉淀')).toBeTruthy()
    expect(screen.getByText(/新经验 1 条/)).toBeTruthy()
    expect(screen.getByText(/2\/5 条注入/)).toBeTruthy()
    expect(screen.getByText(/结算 1 次/)).toBeTruthy()
  })

  it('shows experience details after expanding', () => {
    render(<CognitionSummaryNodeView node={{ data: data() }} t={t} />)
    expect(screen.queryByText('exp_208')).toBeNull()
    act(() => { fireEvent.click(screen.getByRole('button')) })
    expect(screen.getByText('exp_208')).toBeTruthy()
    expect(screen.getByText('快照测试并发超时定位')).toBeTruthy()
    // Collapse hides the detail again.
    act(() => { fireEvent.click(screen.getByRole('button')) })
    expect(screen.queryByText('exp_208')).toBeNull()
  })

  it('renders an empty-detail note when the turn accumulated no experience', () => {
    render(<CognitionSummaryNodeView node={{ data: data({ newExperiences: [] }) }} t={t} />)
    act(() => { fireEvent.click(screen.getByRole('button')) })
    expect(screen.getByText('无明细')).toBeTruthy()
  })
})
