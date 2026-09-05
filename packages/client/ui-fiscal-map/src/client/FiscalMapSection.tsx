/**
 * Fiscal Map settings section: an interactive choropleth of provincial
 * public-budget indicators (2023) plus a ranked table. The map renders from
 * the embedded GeoJSON + dataset — no network, no services — so the whole
 * surface is component-local state: the selected metric, the hovered
 * province (tooltip), and the pinned province (detail card).
 */
import { useMemo, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { Bucket } from './color.ts'
import { bucketFor, BUCKET_COUNT, metricDomain } from './color.ts'
import { CHINA_FEATURES } from './china-geo.ts'
import { FISCAL_YEAR, PROVINCES, provinceByName } from './fiscal-data.ts'
import { geometryPath, MAP_HEIGHT, MAP_WIDTH } from './geometry.ts'
import type { FiscalMapLocaleKey } from './locales.ts'
import { formatMetricValue, METRICS, metricIsPercent, metricValue, type FiscalMetric } from './metrics.ts'
import css from './FiscalMapSection.module.css'

/** Full component props delivered by the settings.section outlet. */
export type FiscalMapSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'fiscalMap'>

/** Locale key of a metric (for the selector labels). */
const METRIC_KEYS: Record<FiscalMetric, FiscalMapLocaleKey> = {
  revenue: 'metricRevenue',
  expenditure: 'metricExpenditure',
  tax: 'metricTax',
  vat: 'metricVat',
  selfRatio: 'metricSelfRatio',
}

/** One rendered province: name, SVG path data, and its bucket for the metric. */
interface ProvinceGlyph {
  readonly name: string
  readonly d: string
  readonly bucket: Bucket
}

/**
 * Render the fiscal map section.
 * @param props - composed slot props (owner + locale seats).
 * @returns the section element tree.
 */
export function FiscalMapSection({ t }: FiscalMapSectionProps) {
  const [metric, setMetric] = useState<FiscalMetric>('revenue')
  const [hovered, setHovered] = useState<string | null>(null)
  const [pinned, setPinned] = useState<string | null>(null)

  const domain = useMemo(
    () => metricDomain(PROVINCES.map(p => metricValue(p, metric))),
    [metric],
  )

  const glyphs: readonly ProvinceGlyph[] = useMemo(() => CHINA_FEATURES.map(feature => {
    const record = provinceByName(feature.name)
    return {
      name: feature.name,
      d: geometryPath(feature.geometry),
      bucket: bucketFor(record === undefined ? null : metricValue(record, metric), domain),
    }
  }), [metric, domain])

  const hoveredRecord = hovered === null ? undefined : provinceByName(hovered)
  const pinnedRecord = pinned === null ? undefined : provinceByName(pinned)

  const ranked = useMemo(() => {
    const withValue = PROVINCES
      .map(province => ({ province, value: metricValue(province, metric) }))
      .sort((a, b) => {
        if (a.value === null && b.value === null) return 0
        if (a.value === null) return 1
        if (b.value === null) return -1
        return b.value - a.value
      })
    return withValue
  }, [metric])

  return (
    <div className={css.section}>
      <header className={css.header}>
        <h2 className={css.title}>{t('title')}</h2>
        <p className={css.subtitle}>{t('subtitle')} · {FISCAL_YEAR}</p>
      </header>

      <div className={css.metrics} role="group" aria-label={t('title')}>
        {METRICS.map(key => (
          <button
            key={key}
            type="button"
            className={metric === key ? css.metricActive : css.metric}
            aria-pressed={metric === key}
            onClick={() => setMetric(key)}
          >
            {t(METRIC_KEYS[key])}
          </button>
        ))}
      </div>

      <div className={css.mapArea}>
        <svg
          className={css.map}
          viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
          role="img"
          aria-label={t('title')}
        >
          {glyphs.map(glyph => (
            <path
              key={glyph.name}
              className={glyph.bucket === null ? css.noData : css[`q${glyph.bucket}` as keyof typeof css]}
              d={glyph.d}
              data-province={glyph.name}
              onMouseEnter={() => setHovered(glyph.name)}
              onMouseLeave={() => setHovered(current => (current === glyph.name ? null : current))}
              onClick={() => setPinned(current => (current === glyph.name ? null : glyph.name))}
            />
          ))}
        </svg>

        <div className={css.legend} aria-label={t('metricSelfRatio')}>
          {Array.from({ length: BUCKET_COUNT }, (_, index) => (
            <span key={index} className={css.legendItem}>
              <i className={css[`q${index}` as keyof typeof css]} />
              <span>{t('valueColumn')}</span>
            </span>
          ))}
          <span className={css.legendItem}>
            <i className={css.noData} />
            <span>{t('noData')}</span>
          </span>
        </div>

        <div className={css.hint}>{t('hoverHint')}</div>

        {hoveredRecord !== undefined && (
          <div className={css.tooltip} role="tooltip">
            <strong>{hoveredRecord.name}</strong>
            <span>{formatMetricValue(metricValue(hoveredRecord, metric), metric)}</span>
          </div>
        )}
      </div>

      {pinnedRecord !== undefined && (
        <aside className={css.detail} aria-label={pinnedRecord.name}>
          <h3>{pinnedRecord.name}</h3>
          <dl className={css.detailGrid}>
            {METRICS.map(key => (
              <div key={key} className={css.detailRow}>
                <dt>{t(METRIC_KEYS[key])}</dt>
                <dd>{formatMetricValue(metricValue(pinnedRecord, key), key)}</dd>
              </div>
            ))}
          </dl>
        </aside>
      )}

      <section className={css.ranking} aria-label={t('rankingTitle')}>
        <h3>{t('rankingTitle')}</h3>
        <table className={css.table}>
          <thead>
            <tr>
              <th scope="col">{t('rankColumn')}</th>
              <th scope="col">{t('provinceColumn')}</th>
              <th scope="col">{t('valueColumn')}（{metricIsPercent(metric) ? t('unitPercent') : t('unitBillion')}）</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map(({ province, value }, index) => (
              <tr
                key={province.name}
                className={pinned === province.name ? css.rowPinned : undefined}
                onMouseEnter={() => setHovered(province.name)}
                onMouseLeave={() => setHovered(current => (current === province.name ? null : current))}
                onClick={() => setPinned(current => (current === province.name ? null : province.name))}
              >
                <td>{index + 1}</td>
                <td>{province.name}</td>
                <td>{value === null ? t('noData') : formatMetricValue(value, metric)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <footer className={css.source}>{t('sourceNote')}</footer>
    </div>
  )
}
