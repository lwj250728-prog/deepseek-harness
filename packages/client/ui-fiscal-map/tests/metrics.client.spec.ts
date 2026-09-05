import { describe, expect, it } from 'vitest'
import type { ProvinceFiscal } from '../src/client/fiscal-data.ts'
import {
  formatMetricValue, METRICS, metricIsPercent, metricValue,
} from '../src/client/metrics.ts'

const PROVINCE: ProvinceFiscal = {
  name: '广东省',
  revenue: 1000,
  expenditure: 500,
  tax: 800,
  vat: 300,
}

const NO_VAT: ProvinceFiscal = { ...PROVINCE, vat: null }

describe('metricValue', () => {
  it('reads published figures for the four headline metrics', () => {
    expect(metricValue(PROVINCE, 'revenue')).toBe(1000)
    expect(metricValue(PROVINCE, 'expenditure')).toBe(500)
    expect(metricValue(PROVINCE, 'tax')).toBe(800)
    expect(metricValue(PROVINCE, 'vat')).toBe(300)
  })

  it('derives the self-sufficiency ratio as revenue / expenditure percent', () => {
    expect(metricValue(PROVINCE, 'selfRatio')).toBe(200)
  })

  it('reads null for unpublished figures', () => {
    expect(metricValue(NO_VAT, 'vat')).toBeNull()
  })

  it('returns null for self-sufficiency when expenditure is not positive', () => {
    expect(metricValue({ ...PROVINCE, expenditure: 0 }, 'selfRatio')).toBeNull()
  })

  it('exposes all five metrics in display order', () => {
    expect(METRICS).toEqual(['revenue', 'expenditure', 'tax', 'vat', 'selfRatio'])
  })
})

describe('metricIsPercent', () => {
  it('marks only selfRatio as percentage-valued', () => {
    expect(metricIsPercent('selfRatio')).toBe(true)
    expect(metricIsPercent('revenue')).toBe(false)
    expect(metricIsPercent('expenditure')).toBe(false)
    expect(metricIsPercent('tax')).toBe(false)
    expect(metricIsPercent('vat')).toBe(false)
  })
})

describe('formatMetricValue', () => {
  it('formats 亿元 values with one decimal', () => {
    expect(formatMetricValue(1000, 'revenue')).toBe('1000.0 亿元')
  })

  it('formats percentage values with a percent sign', () => {
    expect(formatMetricValue(83.333, 'selfRatio')).toBe('83.3%')
  })

  it('returns an empty string for missing values', () => {
    expect(formatMetricValue(null, 'vat')).toBe('')
  })
})
