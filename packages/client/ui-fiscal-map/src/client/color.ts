/**
 * Pure choropleth color scaling: map a numeric metric value onto one of five
 * fill buckets via a linear scale between the dataset min and max. No React,
 * no DOM — unit-testable in the node lane.
 */

/** Number of sequential fill buckets (0 = lowest, 4 = highest). */
export const BUCKET_COUNT = 5

/** Fill-bucket index for a value, or null when the value is missing. */
export type Bucket = 0 | 1 | 2 | 3 | 4 | null

/** Domain endpoints of the active metric over the visible dataset. */
export interface MetricDomain {
  readonly min: number
  readonly max: number
}

/**
 * Compute the linear domain over the non-null values.
 * @param values - metric values, nulls treated as missing.
 * @returns the [min, max] domain, or null when no value exists.
 */
export function metricDomain(values: readonly (number | null)[]): MetricDomain | null {
  const present = values.filter((v): v is number => v !== null)
  if (present.length === 0) return null
  return { min: Math.min(...present), max: Math.max(...present) }
}

/**
 * Assign a value to one of {@link BUCKET_COUNT} buckets on a linear scale.
 * @param value - the metric value (null → null bucket).
 * @param domain - scale endpoints; values outside are clamped to the edge buckets.
 * @returns bucket index 0..4, or null for a missing value.
 */
export function bucketFor(value: number | null, domain: MetricDomain | null): Bucket {
  if (value === null || domain === null || domain.max <= domain.min) {
    return value === null ? null : 4
  }
  const t = Math.min(1, Math.max(0, (value - domain.min) / (domain.max - domain.min)))
  const index = Math.min(BUCKET_COUNT - 1, Math.floor(t * BUCKET_COUNT))
  return index as Bucket
}
