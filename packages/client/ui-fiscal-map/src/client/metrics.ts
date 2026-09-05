/**
 * Fiscal metric model: which indicator the choropleth is coloring, how to
 * read its value off a province record, and its display unit. Pure module —
 * unit-testable in the node lane.
 */
import type { ProvinceFiscal } from './fiscal-data.ts'

/** The five selectable choropleth indicators. */
export type FiscalMetric = 'revenue' | 'expenditure' | 'tax' | 'vat' | 'selfRatio'

/** All metrics in display order (the selector row order). */
export const METRICS: readonly FiscalMetric[] = ['revenue', 'expenditure', 'tax', 'vat', 'selfRatio']

/**
 * Read a metric's numeric value off a province record; `selfRatio` is
 * derived (revenue ÷ expenditure as a percentage), others are the published
 * figures. Missing published values (tax/vat) read as null.
 * @param province - the province record.
 * @param metric - the indicator to read.
 * @returns the value, or null when the province has no published figure.
 */
export function metricValue(province: ProvinceFiscal, metric: FiscalMetric): number | null {
  switch (metric) {
    case 'revenue': return province.revenue
    case 'expenditure': return province.expenditure
    case 'tax': return province.tax
    case 'vat': return province.vat
    case 'selfRatio': {
      if (province.expenditure <= 0) return null
      return (province.revenue / province.expenditure) * 100
    }
  }
}

/** Whether a metric is expressed as a percentage (selfRatio) or 亿元. */
export function metricIsPercent(metric: FiscalMetric): boolean {
  return metric === 'selfRatio'
}

/** Format a metric value for display with its unit. */
export function formatMetricValue(value: number | null, metric: FiscalMetric): string {
  if (value === null) return ''
  if (metricIsPercent(metric)) return `${value.toFixed(1)}%`
  return `${value.toFixed(1)} 亿元`
}
