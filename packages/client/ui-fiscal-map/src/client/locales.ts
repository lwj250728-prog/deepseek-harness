/** Copy dictionaries for the fiscal-map Settings section. */

/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  nav: '财政地图',
  title: '全国财政地图',
  subtitle: '各省一般公共预算收支、税收与增值税（2023 年度）',
  metricRevenue: '一般公共预算收入',
  metricExpenditure: '一般公共预算支出',
  metricTax: '税收收入',
  metricVat: '增值税',
  metricSelfRatio: '财政自给率',
  unitBillion: '亿元',
  unitPercent: '%',
  noData: '暂无公开数据',
  sourceNote: '数据来源：各省财政厅 2023 年预算执行报告/决算报告公开数据；香港、澳门、台湾未纳入全国一般公共预算口径。',
  hoverHint: '悬停查看详情，点击固定选中',
  rankingTitle: '省份排名',
  rankColumn: '排名',
  provinceColumn: '省份',
  valueColumn: '数值',
} satisfies Record<string, string>

/** Fiscal-map locale key union. */
export type FiscalMapLocaleKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  nav: 'Fiscal Map',
  title: 'National Fiscal Map',
  subtitle: 'Provincial public-budget revenue, expenditure, tax and VAT (2023)',
  metricRevenue: 'General budget revenue',
  metricExpenditure: 'General budget expenditure',
  metricTax: 'Tax revenue',
  metricVat: 'Value-added tax',
  metricSelfRatio: 'Fiscal self-sufficiency',
  unitBillion: '100M CNY',
  unitPercent: '%',
  noData: 'No public data',
  sourceNote: 'Source: 2023 budget-execution reports published by provincial finance bureaus; Hong Kong, Macau and Taiwan are outside the national general public budget scope.',
  hoverHint: 'Hover for details, click to pin a province',
  rankingTitle: 'Province ranking',
  rankColumn: 'Rank',
  provinceColumn: 'Province',
  valueColumn: 'Value',
} satisfies Record<FiscalMapLocaleKey, string>
