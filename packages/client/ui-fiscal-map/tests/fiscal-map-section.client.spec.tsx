// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FiscalMapSection, type FiscalMapSectionProps } from '../src/client/FiscalMapSection.tsx'
import { en, type FiscalMapLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: FiscalMapLocaleKey): string => en[key]) as FiscalMapSectionProps['t']

function props(): FiscalMapSectionProps {
  return { t } as FiscalMapSectionProps
}

function provincePath(container: HTMLElement, name: string): SVGPathElement {
  const path = container.querySelector(`path[data-province="${name}"]`)
  if (path === null) throw new Error(`missing path for ${name}`)
  return path as SVGPathElement
}

describe('FiscalMapSection', () => {
  it('renders the header, metric selector, map, ranking and source note', () => {
    const view = render(<FiscalMapSection {...props()} />)
    expect(screen.getByRole('heading', { name: en.title })).toBeTruthy()
    expect(screen.getByText((content: string) => content.includes(en.subtitle))).toBeTruthy()
    for (const key of ['metricRevenue', 'metricExpenditure', 'metricTax', 'metricVat', 'metricSelfRatio'] as const) {
      expect(screen.getByRole('button', { name: en[key] })).toBeTruthy()
    }
    expect(screen.getByRole('img', { name: en.title })).toBeTruthy()
    expect(screen.getByRole('heading', { name: en.rankingTitle })).toBeTruthy()
    expect(screen.getByText(en.sourceNote)).toBeTruthy()
    expect(view.container.querySelectorAll('path[data-province]').length).toBeGreaterThan(30)
  })

  it('defaults to the revenue metric and colors 广东 in the top bucket', () => {
    const view = render(<FiscalMapSection {...props()} />)
    const gd = provincePath(view.container, '广东省')
    expect(gd.getAttribute('class')).toContain('q4')
    // Top of the revenue ranking: 广东 leads, 西藏 trails.
    const rows = view.container.querySelectorAll('tbody tr')
    expect(rows[0]?.textContent).toContain('广东省')
    expect(rows[rows.length - 1]?.textContent).toContain('西藏自治区')
  })

  it('switches metrics and re-colors the map and ranking', () => {
    const view = render(<FiscalMapSection {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: en.metricSelfRatio }))
    // Self-sufficiency = revenue/expenditure: 上海 leads, 西藏 trails.
    const gd = provincePath(view.container, '西藏自治区')
    expect(gd.getAttribute('class')).toContain('q0')
    const rows = view.container.querySelectorAll('tbody tr')
    expect(rows[0]?.textContent).toContain('上海市')
    expect(rows[rows.length - 1]?.textContent).toContain('西藏自治区')
  })

  it('shows the tooltip on hover and hides it on leave', () => {
    const view = render(<FiscalMapSection {...props()} />)
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.mouseEnter(provincePath(view.container, '江苏省'))
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip.textContent).toContain('江苏省')
    expect(tooltip.textContent).toContain('9930.0')
    fireEvent.mouseLeave(provincePath(view.container, '江苏省'))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('pins a province on click and shows its full metric detail', () => {
    const view = render(<FiscalMapSection {...props()} />)
    fireEvent.click(provincePath(view.container, '浙江省'))
    const detail = screen.getByRole('complementary', { name: '浙江省' })
    expect(detail.textContent).toContain('8600.0 亿元')
    expect(detail.textContent).toContain('12353.1 亿元')
    // Clicking again unpins.
    fireEvent.click(provincePath(view.container, '浙江省'))
    expect(screen.queryByRole('complementary', { name: '浙江省' })).toBeNull()
  })

  it('renders no-data provinces in the no-data state and ranks them last', () => {
    const view = render(<FiscalMapSection {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: en.metricTax }))
    // 河北 has no published tax figure.
    const hebei = provincePath(view.container, '河北省')
    expect(hebei.getAttribute('class')).toContain('noData')
    const rows = view.container.querySelectorAll('tbody tr')
    expect(rows[rows.length - 1]?.textContent).toContain(en.noData)
    // 西藏 also lacks a tax figure and keeps its revenue-order position among nulls.
    expect(rows[rows.length - 1]?.textContent).toContain('西藏自治区')
  })

  it('marks pinned ranking rows visually', () => {
    const view = render(<FiscalMapSection {...props()} />)
    const row = view.container.querySelectorAll('tbody tr')[0] as HTMLTableRowElement
    fireEvent.click(row)
    expect(row.className).toContain('rowPinned')
  })

  it('keeps pinned and hovered state consistent after metric switch', () => {
    const view = render(<FiscalMapSection {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: en.metricExpenditure }))
    fireEvent.click(provincePath(view.container, '广东省'))
    expect(screen.getByRole('complementary', { name: '广东省' })).toBeTruthy()
    fireEvent.mouseEnter(provincePath(view.container, '四川省'))
    expect(screen.getByRole('tooltip').textContent).toContain('四川省')
  })

  it('replaces hover and pin when moving to another province', () => {
    const view = render(<FiscalMapSection {...props()} />)
    fireEvent.mouseEnter(provincePath(view.container, '江苏省'))
    // Leave a different province than the one hovered: hover must stay.
    fireEvent.mouseLeave(provincePath(view.container, '广东省'))
    expect(screen.getByRole('tooltip').textContent).toContain('江苏省')
    // Pin 浙江, then pin 四川: the pin moves, not stacks.
    fireEvent.click(provincePath(view.container, '浙江省'))
    fireEvent.click(provincePath(view.container, '四川省'))
    expect(screen.queryByRole('complementary', { name: '浙江省' })).toBeNull()
    expect(screen.getByRole('complementary', { name: '四川省' })).toBeTruthy()
  })

  it('interacts through the ranking rows as well as the map', () => {
    const view = render(<FiscalMapSection {...props()} />)
    const rows = view.container.querySelectorAll('tbody tr')
    const first = rows[0] as HTMLTableRowElement
    const second = rows[1] as HTMLTableRowElement
    fireEvent.mouseEnter(first)
    expect(screen.getByRole('tooltip').textContent).toContain('广东省')
    // Leave a row different from the hovered one: hover stays.
    fireEvent.mouseLeave(second)
    expect(screen.getByRole('tooltip').textContent).toContain('广东省')
    fireEvent.mouseLeave(first)
    expect(screen.queryByRole('tooltip')).toBeNull()
    // Click row 1 then row 2: the pin moves; clicking the pinned row again clears it.
    fireEvent.click(first)
    fireEvent.click(second)
    expect(screen.queryByRole('complementary', { name: '广东省' })).toBeNull()
    fireEvent.click(second)
    expect(screen.queryByRole('complementary', { name: '江苏省' })).toBeNull()
  })
})
