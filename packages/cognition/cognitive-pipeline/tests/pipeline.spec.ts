import { describe, expect, it } from 'vitest'
import { executeTool, pipelineHarness, stubAgent } from './helpers.ts'
import { frameCalibrationInput } from '../src/prompts.ts'

const SAR_A = JSON.stringify({
  situation: '清晨天气晴朗',
  action: '晨跑五公里',
  outcome: '精力充沛一整天',
  action_keywords: ['晨跑', '运动'],
  outcome_utility_score: { material_gain: 8, emotional_valence: 7, energy_cost: 3 },
})

const SAR_B = JSON.stringify({
  situation: '深夜疲惫',
  action: '熬夜刷剧',
  outcome: '次日状态极差',
  action_keywords: ['熬夜', '刷剧'],
  outcome_utility_score: { material_gain: 2, emotional_valence: 2, energy_cost: 8 },
})

const OOD_KNOWN = JSON.stringify({
  is_known: true,
  confidence_score: 90,
  reasoning_short: '晨跑是历史模式的合理变体',
  suggested_initial_risk_level: 'low',
})

const CALIB = JSON.stringify({
  base_success_rate: 80,
  risk_factors: ['天气突变', '关键人物缺席', '政策窗口关闭'],
  final_confidence_interval_low: 60,
  final_confidence_interval_high: 90,
  final_calibrated_probability: 75,
  advice_preview: '按计划行动',
})

const RECON = JSON.stringify({
  new_clusters: [
    {
      cluster_name: '正向运动簇',
      decision_rule: 'if 清晨 then 坚持晨跑',
      expected_utility_range: { low: 6, high: 10 },
      supporting_evidence_ids: ['exp_1', 'exp_2', 'exp_3'],
      fallback_action: '适度运动',
    },
    {
      cluster_name: '负向熬夜簇',
      decision_rule: 'if 深夜 then 避免熬夜',
      expected_utility_range: { low: 0, high: 4 },
      supporting_evidence_ids: ['exp_4', 'exp_5', 'exp_6'],
      fallback_action: '提前休息',
    },
  ],
  taxonomy_summary_short: '重组为2簇：运动正向/熬夜负向',
})

describe('cognitive pipeline integration', () => {
  it('runs the full remember → predict → report → rebuild loop with a scripted LLM', async () => {
    // LLM-extracted action vectors carry keyword tokens, so the retrieval is
    // near-identical but not exact: the flat-top OOD signal fires, the review
    // (response 6) confirms "known", then calibration and reconstruction run.
    const script = [SAR_A, SAR_A, SAR_A, SAR_B, SAR_B, SAR_B, OOD_KNOWN, CALIB, RECON]
    const { ctx, teardown } = await pipelineHarness(
      // 6 experiences leave a 1-sample validation slice; lower the acceptance
      // floor so this suite exercises the accept path rather than deferring.
      { provider: 'cognition-test', model: 'm', predictionErrorThreshold: 0, minValidationCount: 1 },
      script,
    )
    try {
      const service = ctx.cognitivePipeline

      // ── remember: 6 experiences across two utility groups ────────────────
      for (let index = 0; index < 3; index += 1) {
        await service.remember({ rawText: '清晨天气晴朗。晨跑五公里。精力充沛一整天。' })
      }
      for (let index = 0; index < 3; index += 1) {
        await service.remember({ rawText: '深夜疲惫。熬夜刷剧。次日状态极差。' })
      }
      expect(service.store.experiencesSnapshot()).toHaveLength(6)

      // ── predict: known path with LLM calibration ─────────────────────────
      const prediction = await service.predict({ situation: '清晨', action: '晨跑五公里' })
      expect(prediction.isNovel).toBe(false)
      expect(prediction.topHitCount).toBe(6)
      // raw 0.75 shrunk toward 0.5 by alpha=50 with k=6.
      expect(prediction.calibratedProbability).toBeGreaterThan(0.5)
      expect(prediction.calibratedProbability).toBeLessThan(0.65)
      expect(prediction.advice).toContain('按计划行动')

      // ── report: feedback with a known quality ────────────────────────────
      const feedback = await service.report({
        predictionId: prediction.predictionId,
        actualOutcome: '跑完神清气爽',
        outcomeQuality: 9,
      })
      expect(feedback.status).toBe('logged')
      expect(feedback.triggerRebuild).toBe(false)
      const resolved = service.store.getPrediction(prediction.predictionId)
      expect(resolved?.resolvedAt).not.toBeNull()

      // ── rebuild: LLM reconstruction accepted after backtest ──────────────
      const rebuild = await service.rebuild('global')
      expect(rebuild.accepted).toBe(true)
      expect(rebuild.clusterCount).toBe(2)
      expect(rebuild.rejectedClusters).toBe(0)
      expect(rebuild.taxonomyVersion).toBe(1)

      const taxonomy = service.taxonomy()
      expect(taxonomy?.summaryShort).toContain('重组为2簇')
      expect(service.store.experiencesSnapshot().filter(exp => exp.clusterId === null)).toHaveLength(0)

      // ── success reference: situation matches the accepted success cluster ─
      const referenced = await service.predict({ situation: '清晨', action: '晨跑五公里' })
      expect(referenced.successReference).not.toBeNull()
      expect(referenced.successReference?.clusterName).toBe('正向运动簇')
      expect(referenced.advice).toContain('参照成功策略')

      // ── the dynamic system-prompt section carries the summary ────────────
      const assembled = await ctx.systemPrompt.assemble()
      const section = assembled.sections.find(item => item.name === 'cognition:taxonomy')
      expect(section?.text).toContain('分类体系摘要')
      expect(section?.text).toContain('运动正向')
    } finally {
      await teardown()
    }
  })

  it('exposes the pipeline as model tools callable by an agent', async () => {
    const { ctx, teardown } = await pipelineHarness()
    try {
      const { agent } = stubAgent('tool-agent')
      ctx.agents.register(agent)

      const remembered = await executeTool(ctx, 'remember_experience', {
        raw_text: '清晨。晨跑五公里。精力充沛。',
      }, agent) as Record<string, unknown>
      expect(remembered.exp_id).toBe('exp_1')
      expect(remembered.outcome_utility).toEqual({ material_gain: 5, emotional_valence: 5, energy_cost: 5 })

      const predicted = await executeTool(ctx, 'predict_outcome', {
        situation: '清晨',
        action: '晨跑五公里',
      }, agent) as Record<string, unknown>
      expect(predicted.is_novel).toBe(false)
      expect(predicted.top_hit_count).toBe(1)
      expect(typeof predicted.prediction_id).toBe('string')

      const reported = await executeTool(ctx, 'report_outcome', {
        prediction_id: predicted.prediction_id as string,
        actual_outcome: '很好',
        outcome_quality: 8,
      }, agent) as Record<string, unknown>
      expect(reported.status).toBe('logged')

      const inspected = await executeTool(ctx, 'inspect_memory', {}, agent) as Record<string, unknown>
      expect(inspected.experience_count).toBe(1)
      expect(inspected.prediction_count).toBe(1)
      expect(inspected.resolved_prediction_count).toBe(1)

      const rebuilt = await executeTool(ctx, 'rebuild_taxonomy', { scope: 'global' }, agent) as Record<string, unknown>
      expect(typeof rebuilt.accepted).toBe('boolean')
      expect(rebuilt.sample_count).toBeLessThan(3)
    } finally {
      await teardown()
    }
  })

  it('unregisters tools and the prompt section on dispose', async () => {
    const harness = await pipelineHarness()
    try {
      for (const name of ['remember_experience', 'simulate_experience', 'predict_outcome', 'report_outcome', 'rebuild_taxonomy', 'inspect_memory']) {
        expect(harness.ctx.tools.get(name)?.name).toBe(name)
      }
      await harness.fiber.dispose()
      for (const name of ['remember_experience', 'simulate_experience', 'predict_outcome', 'report_outcome', 'rebuild_taxonomy', 'inspect_memory']) {
        expect(harness.ctx.tools.get(name)).toBeUndefined()
      }
      const assembled = await harness.ctx.systemPrompt.assemble()
      expect(assembled.sections.some(item => item.name === 'cognition:taxonomy')).toBe(false)
    } finally {
      await harness.teardown()
    }
  })

  it('degrades SAR extraction when the model omits utility fields', async () => {
    // The model returns a triplet without outcome_utility_score; the pipeline
    // must fall back to the deterministic neutral split rather than invent a
    // partial 5/5/5 from missing fields.
    const script = [JSON.stringify({
      situation: '清晨',
      action: '晨跑',
      outcome: '精力充沛',
      action_keywords: ['晨跑'],
    })]
    const { ctx, teardown } = await pipelineHarness({ provider: 'cognition-test', model: 'm' }, script)
    try {
      const remembered = await ctx.cognitivePipeline.remember({ rawText: '清晨。晨跑。精力充沛。' })
      expect(remembered.sar.outcomeUtility).toEqual({ materialGain: 5, emotionalValence: 5, energyCost: 5 })
      // The stored experience still carries a valid outcome vector (no crash).
      expect(ctx.cognitivePipeline.store.getExperience(remembered.expId)?.outcomeVector.length).toBeGreaterThan(0)
    } finally {
      await teardown()
    }
  })

  it('fuses failure symptoms into the situation in the deterministic fallback', async () => {
    // No LLM route: the fallback must put the observable symptom ("挂起") into
    // the situation so a later "测试挂起" task can retrieve this experience.
    const { ctx, teardown } = await pipelineHarness()
    try {
      const remembered = await ctx.cognitivePipeline.remember({
        rawText: '实现插件时测试突然无限挂起。改成无循环算术算法。测试全部恢复。',
      })
      expect(remembered.sar.situation).toContain('挂起')
      // The stored experience's situation vector now carries the symptom, so
      // the dual-axis retrieval of a symptom task should hit it.
      const vector = ctx.cognitivePipeline.store.getExperience(remembered.expId)?.actionVector
      expect(vector?.length).toBeGreaterThan(0)
    } finally {
      await teardown()
    }
  })

  it('generates a simulated experience and verifies it through report feedback', async () => {
    const script = [SAR_A, OOD_KNOWN, CALIB]
    const { ctx, teardown } = await pipelineHarness(
      { provider: 'cognition-test', model: 'm', simulationFastTrackThreshold: 0.5, simulationPermanentThreshold: 2 },
      script,
    )
    try {
      const simulated = await ctx.cognitivePipeline.simulate({ situation: '清晨', action: '晨跑五公里' })
      const stored = ctx.cognitivePipeline.store.getExperience(simulated.expId)
      expect(stored?.simulated).toBe(true)
      expect(stored?.verification).toBe('unverified')
      expect(stored?.evidenceScore).toBe(0)

      // Predict the simulated action, then report decisive high-quality feedback.
      const prediction = await ctx.cognitivePipeline.predict({ situation: '清晨', action: '晨跑五公里' })
      await ctx.cognitivePipeline.report({
        predictionId: prediction.predictionId,
        actualOutcome: '跑完神清气爽',
        outcomeQuality: 9,
      })
      const after = ctx.cognitivePipeline.store.getExperience(simulated.expId)
      // q=9 → decisiveness 0.8 ≥ fast-track 0.5 → provisional.
      expect(after?.verification).toBe('provisional')
      expect(after?.evidenceScore).toBeGreaterThan(0)
    } finally {
      await teardown()
    }
  })

  it('records a pipeline-own meta experience directly and retrieves it by action', async () => {
    const { ctx, teardown } = await pipelineHarness()
    try {
      const expId = ctx.cognitivePipeline.rememberMeta({
        situation: '检索路由歧义：情境「X」与簇「Y」的余弦余量仅 0.050，确定性路由置信低',
        action: '打包并推送插件到GitHub',
        outcome: '路由余量低于 0.1，确定性路由不可靠，应改用 LLM 路由',
        utility: { materialGain: 3, emotionalValence: 4, energyCost: 5 },
      })
      const stored = ctx.cognitivePipeline.store.getExperience(expId)
      expect(stored?.meta).toBe(true)
      expect(stored?.simulated).toBe(false)
      expect(stored?.verification).toBe('verified')
      // The meta experience is retrievable by its action, so the calibration
      // layer can see the recorded failure pattern for similar queries.
      const hits = ctx.cognitivePipeline.hot.retrieveTopK('打包并推送插件到GitHub', 3)
      expect(hits[0]?.exp.expId).toBe(expId)
    } finally {
      await teardown()
    }
  })

  it('marks pipeline-own meta experiences in the calibration prompt', () => {
    const text = frameCalibrationInput(
      'situation',
      'action',
      undefined,
      1,
      0,
      [
        { expId: 'exp_1', actionKeywords: 'k', utility: '3/4/5', meta: true },
        { expId: 'exp_2', actionKeywords: 'k', utility: '8/7/3' },
      ],
    )
    expect(text).toContain('【元经验-管道自身】')
    // A regular sample is not marked.
    expect(text).not.toContain('【元经验-管道自身】exp_2')
  })

  it('skips pure chat in automatic accumulation (pre-filter, no LLM call)', async () => {
    const { ctx, teardown } = await pipelineHarness({ autoAccumulate: true })
    try {
      const before = ctx.cognitivePipeline.store.experiencesSnapshot().length
      const result = await ctx.cognitivePipeline.accumulateTurn({
        situation: '你好',
        action: '回复问候',
        outcome: '轮次结束',
        toolCallCount: 0,
        failed: false,
        turnId: 1,
      })
      expect(result).toBeNull()
      expect(ctx.cognitivePipeline.store.experiencesSnapshot().length).toBe(before)
    } finally {
      await teardown()
    }
  })

  it('accumulates a substantial turn when the LLM gate accepts', async () => {
    const gate = JSON.stringify({
      should_accumulate: true,
      situation: '构建失败需要恢复依赖基线',
      action: '定位依赖损坏并重装 node_modules',
      outcome: '构建恢复，环境基线重建',
      material_gain: 8,
      emotional_valence: 7,
      energy_cost: 5,
    })
    const { ctx, teardown } = await pipelineHarness(
      { provider: 'cognition-test', model: 'm', autoAccumulate: true },
      [gate],
    )
    try {
      const expId = await ctx.cognitivePipeline.accumulateTurn({
        situation: '构建失败',
        action: '排查依赖链接并重装 node_modules 后构建恢复',
        outcome: '构建通过',
        toolCallCount: 3,
        failed: true,
        turnId: 2,
      })
      expect(expId).not.toBeNull()
      const stored = ctx.cognitivePipeline.store.getExperience(expId as string)
      expect(stored?.sar.situation).toBe('构建失败需要恢复依赖基线')
      expect(stored?.sar.outcomeUtility.materialGain).toBe(8)
      // An automatically accumulated experience is an ordinary verified record, not meta.
      expect(stored?.meta).not.toBe(true)
      expect(stored?.simulated).toBe(false)
    } finally {
      await teardown()
    }
  })

  it('does not accumulate when the LLM gate rejects', async () => {
    const { ctx, teardown } = await pipelineHarness(
      { provider: 'cognition-test', model: 'm', autoAccumulate: true },
      [JSON.stringify({ should_accumulate: false })],
    )
    try {
      const before = ctx.cognitivePipeline.store.experiencesSnapshot().length
      const result = await ctx.cognitivePipeline.accumulateTurn({
        situation: '完成了一个小任务',
        action: '修改配置文件并重启服务，输出较长的一段操作记录',
        outcome: '服务恢复正常',
        toolCallCount: 2,
        failed: false,
        turnId: 3,
      })
      expect(result).toBeNull()
      expect(ctx.cognitivePipeline.store.experiencesSnapshot().length).toBe(before)
    } finally {
      await teardown()
    }
  })
})
