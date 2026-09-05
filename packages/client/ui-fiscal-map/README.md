# @deepseek-ai/dsh-client-ui-fiscal-map

全国财政地图 —— Web Settings 中的一个页面：把各省公开财政数据渲染成可交互的 choropleth 地图和排名表。

## 功能

- 一个 `settings.section` 页面（导航名「财政地图」），完全离线渲染，不依赖任何网络或主机服务。
- 五个可切换指标：一般公共预算收入、一般公共预算支出、税收收入、增值税、财政自给率（收入/支出，派生）。
- 省级地图按指标线性五档着色；悬停显示悬浮提示，点击固定省份并展开详情卡。
- 排名表按指标降序排列；未公开该指标的省份显示「暂无公开数据」并排在末尾。
- 数据说明脚注标明数据来源与年份。

## 数据

数据集内嵌在 `src/client/fiscal-data.ts`：2023 年度 31 个省级行政区的一般公共预算收支、税收收入、增值税（单位：亿元），取自各省财政厅公开的 2023 年预算执行报告/决算报告，并与《中国财政年鉴 2024》汇总数交叉核对。`tax` / `vat` 在对应省份的公开报告中未单独披露时为 `null`，地图以无数据态呈现，不臆造数字。香港、澳门、台湾不纳入全国一般公共预算口径。地图几何来自阿里云 DataV 省级行政区划 GeoJSON（Douglas-Peucker 0.08° 简化），生成脚本见仓库内 /tmp 简化流程，`china-geo.ts` 头部注明不可手改。

## 扩展点

- 无对外注册的 slot、service 或事件：本包只消费 `settings.section` 声明（通过 `slots.inject` 等待声明，不假设加载顺序）。
- 指标模型在 `src/client/metrics.ts`，新增指标 = 增加 `FiscalMetric` 成员、`metricValue` 分支、`METRIC_KEYS` 与字典文案。
- 更新数据只改 `fiscal-data.ts`；颜色分桶与投影是纯函数（`color.ts` / `geometry.ts`），可独立单测。

## 注册

- `packages/client/ui-fiscal-map`（本包，浏览器半部）
- `tsconfig.client.json` references
- `packages/bundle/web-app/cordis.patch.yml` 插入行
- `packages/bundle/web-app/package.json` 依赖

## Model Experience

None, as the fiscal map is a pure browser-surface feature: no tools, no prompt sections, no session events, and no model-facing data. Nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request, so no prompt or KV-cache state exists to reuse or invalidate.

## Known Limitations and Deferred Work

- **数据快照非实时** — 内嵌的是 2023 年度静态数据；要更新为 2024 年，需替换 `fiscal-data.ts` 并同步 `FISCAL_YEAR` 与脚注文案。
- **税收/增值税部分缺失** — 部分省份的预算执行报告未单列税收收入或增值税，地图对缺失值显示无数据态；后续可补充省级税务部门口径数据。
- **省级粒度** — 只覆盖 31 个大陆省级行政区；不包含地市级与县级财政明细，也不包含政府性基金预算、国有资本经营预算与债务数据。
