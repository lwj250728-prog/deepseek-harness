import { describe, expect, it } from 'vitest'
import { FISCAL_YEAR, PROVINCES, provinceByName } from '../src/client/fiscal-data.ts'

describe('fiscal dataset', () => {
  it('covers all 31 mainland province-level regions', () => {
    expect(PROVINCES.length).toBe(31)
    const names = new Set(PROVINCES.map(p => p.name))
    expect(names.size).toBe(31)
  })

  it('has positive revenue and expenditure everywhere', () => {
    for (const province of PROVINCES) {
      expect(province.revenue).toBeGreaterThan(0)
      expect(province.expenditure).toBeGreaterThan(0)
    }
  })

  it('looks up provinces by name', () => {
    expect(provinceByName('广东省')?.revenue).toBeGreaterThan(0)
    expect(provinceByName('不存在的省')).toBeUndefined()
  })

  it('pins the dataset to the 2023 fiscal year', () => {
    expect(FISCAL_YEAR).toBe(2023)
  })

  it('reports at least some tax and VAT figures (published subsets)', () => {
    expect(PROVINCES.filter(p => p.tax !== null).length).toBeGreaterThan(5)
    expect(PROVINCES.filter(p => p.vat !== null).length).toBeGreaterThan(20)
  })
})
