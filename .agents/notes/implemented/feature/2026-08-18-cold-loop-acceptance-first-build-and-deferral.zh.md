# Agent Note：冷环验收机制——首次建簇基线与暂缓

Status: implemented

[English](2026-08-18-cold-loop-acceptance-first-build-and-deferral.md) | 中文

## 问题

冷环从未验收过任何重建：尽管已有 18 条已反馈预测，存储仍停在 0 簇、taxonomy 版本 0。两个机制缺陷导致，且第二个掩盖了第一个：

- **首次建簇死锁（潜在）。** `runRebuild` 以 `oldError === null ? newError <= 1e-9 : deltaError <= -0.15` 验收。`newError <= 1e-9` 分支为"无旧分类"场景而设，但实际首次构建的 `oldError` 并非 null——`evaluateViews` 对空视图返回的是纯 baseRate 在带标签验证集上的误差（有限数）。死锁分支只在验证切片全为中性时触发，此时 `oldError === null`。
- **零簇状态不可诊断。** 当验证集没有带标签样本时，重建返回 `reason: "无旧分类基线，跳过回写"`——一条掩盖真因的误导信息。可观察状态（0 簇）无法提示机制坏了、数据不足、还是提案本身差。

## 决策

**A — 首次建簇以空视图基线为参照。** `runRebuild` 计算 `referenceError = oldError ?? evaluateViews(all, train, validation, [])`，并以其为参照要求 `deltaError <= -sandboxImprovement` 才验收。因此首套簇只需比"猜 baseRate"好出改进边际即可，潜在的 `newError <= 1e-9` 死锁分支不可达；接近完美的参照（基线或旧分类）仍拒绝，避免 taxonomy 版本空转。

**B — 暂缓成为一等、可诊断的状态。** 新增 `RebuildResult.deferred: boolean`，区分"带标签验证样本不足而推迟"与"按优劣拒绝"。聚类前，`runRebuild` 统计携带真实 materialGain 标签的验证样本数；低于新配置 `minValidationCount`（默认 3）时返回 `deferred: true` 与 `reason: "验证样本不足（带标签 N 条 < M），暂缓重建"`，存储原样不动。`rebuild_taxonomy` 工具输出在 `accepted` 旁携带 `deferred`。

**C — 验收度量连续效用轴，而非 0/1 极性。** `predictionsFor` 预测每条验证经验的 materialGain 标签（最近簇的均值收益，归一化到 [0,1]；未匹配时回落 baseRate 收益），`evaluateViews` 以 `|预测 − 实际|` 对经验的真实 `materialGain / 10` 打分。回滚失败晋升同样使用连续轴。这把验收度量对齐流水线第一性原理的 `|calibrated − observed|` 误差：分类法在预测*效用大小*而非仅经验落入哪个极性桶时才被验收。携带真实 materialGain 标签的经验（反馈回填后的已反馈经验）参与分母；暂缓门槛统计同一标签轴。

## 备选方案

**把首次建簇门槛降到"任何簇都接受"。** 否决：无基线比较就验收，会为不比猜测更好的提案写入 taxonomy；空视图 baseRate 参照保留了真实改进门槛。

**把暂缓并入现有拒绝路径。** 否决：可诊断性正是目的——"数据不足"与"提案未通过验证"需要不同的后续动作与不同原因；布尔加独立 reason 让消费方与日志可区分两者。

**把中性密集的验证切片当作"无信息，静默跳过"。** 否决：这正是产生误导性 0 簇状态的情形；把它浮为暂缓状态就是修复本身。

## 后果

冷环现在会报告为何未重建：对当前真实存储，诊断从误导性的"无旧分类基线，跳过回写"变为"验证样本不足（带标签 0 条 < 3），暂缓重建"。首次建簇验收路径由专门测试覆盖（16 条经验、两个效用家族），断言有限 `oldError` 基线且 `deltaError <= -0.15`；连续轴度量有专门测试（12 条经验、两个收益家族），仅在分类法预测效用大小时通过。`minValidationCount` 是配置字段（默认 3），遵循无硬编码可调参规则；工具 schema 与 README 记录 `deferred` 输出与连续验收轴。

被[2026-08-19-cold-loop-real-data-verification.md](2026-08-19-cold-loop-real-data-verification.md)部分取代：其决策 A 把首次建簇门槛从 `Δerr ≤ −sandboxImprovement` 放宽为相对空视图 baseRate 基线"不劣于"（`Δerr ≤ 0`），因为 15% 余量在年轻 store 的 2-3 条验证切片上统计无意义；baseRate 基线参照与暂缓设计仍然有效。
