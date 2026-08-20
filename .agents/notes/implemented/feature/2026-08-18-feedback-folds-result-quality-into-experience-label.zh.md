# Agent Note：反馈把结果质量回填为经验标签

Status: implemented

[English](2026-08-18-feedback-folds-result-quality-into-experience-label.md) | 中文

## 问题

冷环在真实存储上正确地暂缓了——但诊断暴露了反馈闭环里更深的断裂。`report_outcome` 从 `outcome_quality` 算出预测误差并写回绑定经验，质量本身却被丢弃：`resolvePrediction` 只更新 `predictionError` 与 `cumulativeError`，从不更新 `sar.outcomeUtility`。以高置信度确认了结果质量的经验，于是停留在 `remember` 时记录的中性 5/5/5。实测：exp_9 与 exp_14 携带 0.2–1.8 的累计预测误差却效用中性——"预测错了、质量已知"的经验，被冷环的带标签验证门槛正确地拒绝聚簇。

## 决策

**`resolvePrediction` 接受可选结果质量，并把它回填为绑定经验的效用。** 单一质量轴映射到物质收益（`5 + (q-5)*0.8`，clamp 到 [0,10]，保留一位小数）；情绪与代价不被单一质量分承载，保留记录值。中性 5/5/5 经验在第一次已反馈预测后获得真实标签（q=8 → materialGain 7.4；q=2 → 2.6）。`service.report` 透传 `input.outcomeQuality`。质量缺失时标签不动。

## 备选方案

**把质量映射到全部三个效用轴。** 否决：单一 0–10 质量分承载的是整体结果质量，而非收益/情绪/代价三分；为反馈未携带的轴编造数值会伪造聚类信号。

**质量只留在预测日志。** 否决：这正是观察到的断裂——误差传播了、标签没有，冷环采样对已反馈结果视而不见。

**另写标签字段而非复用 `outcomeUtility`。** 否决：效用向量已是聚类轴与采样过滤的 `successUtilityThreshold`；第二个标签源会分裂存储的唯一权威。

## 后果

已反馈经验携带由反馈推导的真实 materialGain 标签，冷环的带标签验证门槛能看到它们，聚类轴反映被验证的结果而非初始提取。`report_outcome` 的模型可见行为不变（质量本就必填）；回填是 store 级写入。保留的已知限制：映射是从一个质量轴到一个效用轴的线性启发式。验收侧的机制见[冷环验收 note](2026-08-18-cold-loop-acceptance-first-build-and-deferral.md)：带标签验证门槛与连续 `|calibrated − observed|` 验收轴消费的正是本次回填产生的 materialGain 标签。
