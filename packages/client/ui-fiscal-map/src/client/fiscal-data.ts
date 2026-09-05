/**
 * Provincial fiscal dataset backing the fiscal-map choropleth.
 *
 * Data: 2023 annual figures for the 31 mainland province-level regions,
 * sourced from the official provincial budget-execution reports published by
 * each provincial finance bureau (公开预算执行报告/决算报告) and cross-checked
 * against the 2024 China Finance Yearbook aggregates. Units: 亿元 (100M CNY).
 * `tax` (税收收入) and `vat` (增值税) are `null` where the provincial report
 * does not break the figure out in the same published source — the map then
 * renders the region in the no-data state rather than inventing a number.
 * Hong Kong / Macau / Taiwan are excluded: their fiscal statistics follow a
 * different accounting system and are not part of the national general public
 * budget tables this map visualizes.
 */

/** Full official name of a province-level region (matches the map feature name). */
export type ProvinceName =
  | '北京市' | '天津市' | '河北省' | '山西省' | '内蒙古自治区'
  | '辽宁省' | '吉林省' | '黑龙江省' | '上海市' | '江苏省'
  | '浙江省' | '安徽省' | '福建省' | '江西省' | '山东省'
  | '河南省' | '湖北省' | '湖南省' | '广东省' | '广西壮族自治区'
  | '海南省' | '重庆市' | '四川省' | '贵州省' | '云南省'
  | '西藏自治区' | '陕西省' | '甘肃省' | '青海省' | '宁夏回族自治区'
  | '新疆维吾尔自治区'

/** One province's 2023 public-budget record (亿元). */
export interface ProvinceFiscal {
  /** Full official province name; keys the choropleth feature lookup. */
  readonly name: ProvinceName
  /** 一般公共预算收入 — general public budget revenue. */
  readonly revenue: number
  /** 一般公共预算支出 — general public budget expenditure. */
  readonly expenditure: number
  /** 税收收入 — tax revenue; null when not published in the same report. */
  readonly tax: number | null
  /** 增值税 — value-added tax; null when not published in the same report. */
  readonly vat: number | null
}

/** Fiscal data year displayed in the map header. */
export const FISCAL_YEAR = 2023

/** Provincial 2023 records, ordered by revenue (descending). */
export const PROVINCES: readonly ProvinceFiscal[] = [
  { name: '广东省', revenue: 13851.3, expenditure: 18527.0, tax: 10242.5, vat: 4291.82 },
  { name: '江苏省', revenue: 9930.0, expenditure: 15242.3, tax: 7977.0, vat: 3665.17 },
  { name: '浙江省', revenue: 8600.0, expenditure: 12353.1, tax: 7124.1, vat: 3011.46 },
  { name: '上海市', revenue: 8312.5, expenditure: 9638.5, tax: 7109.1, vat: null },
  { name: '山东省', revenue: 7464.7, expenditure: 12581.7, tax: 5229.6, vat: 2027.15 },
  { name: '北京市', revenue: 6181.1, expenditure: 7971.6, tax: 5357.8, vat: null },
  { name: '四川省', revenue: 5529.1, expenditure: 12732.8, tax: 3700.7, vat: 1404.46 },
  { name: '河南省', revenue: 4512.0, expenditure: 11052.5, tax: 2855.1, vat: 1220.21 },
  { name: '河北省', revenue: 4286.1, expenditure: 9606.2, tax: null, vat: 1056.24 },
  { name: '安徽省', revenue: 3939.0, expenditure: 8643.6, tax: null, vat: 1233.05 },
  { name: '湖北省', revenue: 3692.3, expenditure: 9299.1, tax: 2672.4, vat: 1105.98 },
  { name: '福建省', revenue: 3591.9, expenditure: 5859.4, tax: null, vat: 1017.38 },
  { name: '山西省', revenue: 3479.1, expenditure: 6345.6, tax: null, vat: 904.82 },
  { name: '陕西省', revenue: 3437.4, expenditure: 7175.1, tax: 2693.6, vat: 999.31 },
  { name: '湖南省', revenue: 3360.5, expenditure: 9581.1, tax: null, vat: 824.18 },
  { name: '内蒙古自治区', revenue: 3083.4, expenditure: 6836.2, tax: null, vat: 691.18 },
  { name: '江西省', revenue: 3059.6, expenditure: 7492.9, tax: null, vat: 1029.71 },
  { name: '辽宁省', revenue: 2754.0, expenditure: 6574.8, tax: null, vat: 776.58 },
  { name: '重庆市', revenue: 2440.7, expenditure: 5305.0, tax: 1476.0, vat: null },
  { name: '新疆维吾尔自治区', revenue: 2179.7, expenditure: 7567.0, tax: null, vat: 544.32 },
  { name: '云南省', revenue: 2149.4, expenditure: 6730.1, tax: null, vat: 562.35 },
  { name: '贵州省', revenue: 2078.3, expenditure: 6203.7, tax: null, vat: 489.05 },
  { name: '天津市', revenue: 2027.3, expenditure: 3280.4, tax: 1578.9, vat: null },
  { name: '广西壮族自治区', revenue: 1783.9, expenditure: 6101.4, tax: null, vat: 483.71 },
  { name: '黑龙江省', revenue: 1396.0, expenditure: 5776.4, tax: null, vat: 345.31 },
  { name: '吉林省', revenue: 1074.8, expenditure: 4406.9, tax: null, vat: 305.79 },
  { name: '甘肃省', revenue: 1003.5, expenditure: 4521.8, tax: null, vat: 322.47 },
  { name: '海南省', revenue: 900.7, expenditure: 2249.0, tax: null, vat: 221.78 },
  { name: '宁夏回族自治区', revenue: 502.3, expenditure: 1751.4, tax: null, vat: 142.99 },
  { name: '青海省', revenue: 381.3, expenditure: 2188.7, tax: null, vat: 113.33 },
  { name: '西藏自治区', revenue: 236.6, expenditure: 2809.0, tax: null, vat: 91.94 },
]

/** Lookup a province record by its full name. */
export function provinceByName(name: string): ProvinceFiscal | undefined {
  return PROVINCES.find(province => province.name === name)
}
