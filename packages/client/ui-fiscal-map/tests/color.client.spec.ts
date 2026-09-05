import { describe, expect, it } from 'vitest'
import { BUCKET_COUNT, bucketFor, metricDomain } from '../src/client/color.ts'

describe('metricDomain', () => {
  it('computes min/max over non-null values', () => {
    expect(metricDomain([1, 5, null, 3])).toEqual({ min: 1, max: 5 })
  })

  it('returns null when no value is present', () => {
    expect(metricDomain([null, null])).toBeNull()
    expect(metricDomain([])).toBeNull()
  })
})

describe('bucketFor', () => {
  it('maps the domain minimum to bucket 0 and maximum to the last bucket', () => {
    const domain = { min: 0, max: 100 }
    expect(bucketFor(0, domain)).toBe(0)
    expect(bucketFor(100, domain)).toBe(BUCKET_COUNT - 1)
  })

  it('clamps values outside the domain to the edge buckets', () => {
    const domain = { min: 0, max: 100 }
    expect(bucketFor(-10, domain)).toBe(0)
    expect(bucketFor(200, domain)).toBe(BUCKET_COUNT - 1)
  })

  it('assigns interior values to proportional buckets', () => {
    const domain = { min: 0, max: 100 }
    expect(bucketFor(20, domain)).toBe(1)
    expect(bucketFor(50, domain)).toBe(2)
    expect(bucketFor(70, domain)).toBe(3)
  })

  it('returns null for a missing value', () => {
    expect(bucketFor(null, { min: 0, max: 100 })).toBeNull()
  })

  it('falls back to the top bucket when the domain is degenerate', () => {
    expect(bucketFor(42, { min: 5, max: 5 })).toBe(BUCKET_COUNT - 1)
    expect(bucketFor(42, null)).toBe(BUCKET_COUNT - 1)
  })
})
