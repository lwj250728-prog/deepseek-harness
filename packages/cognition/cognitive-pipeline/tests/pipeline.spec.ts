import { describe, expect, it } from 'vitest'
import { executeTool, pipelineHarness, stubAgent } from './helpers.ts'

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
      { provider: 'cognition-test', model: 'm', predictionErrorThreshold: 0 },
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
      for (const name of ['remember_experience', 'predict_outcome', 'report_outcome', 'rebuild_taxonomy', 'inspect_memory']) {
        expect(harness.ctx.tools.get(name)?.name).toBe(name)
      }
      await harness.fiber.dispose()
      for (const name of ['remember_experience', 'predict_outcome', 'report_outcome', 'rebuild_taxonomy', 'inspect_memory']) {
        expect(harness.ctx.tools.get(name)).toBeUndefined()
      }
      const assembled = await harness.ctx.systemPrompt.assemble()
      expect(assembled.sections.some(item => item.name === 'cognition:taxonomy')).toBe(false)
    } finally {
      await harness.teardown()
    }
  })
})
