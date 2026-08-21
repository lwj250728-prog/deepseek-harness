/**
 * Acceptance-criteria coverage: define/rewrite/retire criteria, deterministic
 * claim audits (evidence presence, not truth), the persistence round-trip of
 * `acceptance.json` + `claim_audits.jsonl`, the report-time feedback fold into
 * violated criteria, and the deviation gate that records one meta experience
 * per threshold crossing.
 */

import { describe, expect, it } from 'vitest'
import { CognitiveStore } from '../src/store.ts'
import { executeTool, pipelineHarness, stubAgent } from './helpers.ts'

describe('acceptance criteria and claim audits', () => {
  it('defines criteria, audits claims deterministically, and persists both tables', async () => {
    const { ctx, root, teardown } = await pipelineHarness()
    try {
      const { agent } = stubAgent('acceptance-agent')
      ctx.agents.register(agent)

      const defined = await executeTool(ctx, 'define_acceptance_check', {
        criterion: '声称完成前必须给出证据来源',
        trigger: '声称完成',
        evidence_hint: '引用完成该工作的具体证据',
      }, agent) as Record<string, unknown>
      expect(defined.check_id).toBe('check_1')
      expect(defined.revision).toBe(1)

      // not-applicable: no active trigger appears in claim or situation.
      const notApplicable = await executeTool(ctx, 'verify_claim', {
        claim: '今天天气不错',
        situation: '闲聊',
      }, agent) as Record<string, unknown>
      expect(notApplicable.verdict).toBe('not-applicable')

      // violated: trigger appears, no evidence supplied.
      const violated = await executeTool(ctx, 'verify_claim', {
        claim: '管线已学会验收标准，声称完成',
        situation: '实现验收清单',
      }, agent) as Record<string, unknown>
      expect(violated.verdict).toBe('violated')
      expect(violated.applied_check_ids).toEqual(['check_1'])
      expect(violated.violated_check_ids).toEqual(['check_1'])
      expect(violated.rework_needed).toBe(false)

      // verified: trigger appears and the claim carries evidence.
      const verified = await executeTool(ctx, 'verify_claim', {
        claim: '已完成验收清单实现，声称完成',
        situation: '实现验收清单',
        evidence: '类型检查与包内测试通过，inspect 暴露验收统计',
      }, agent) as Record<string, unknown>
      expect(verified.verdict).toBe('verified')
      expect(verified.satisfied_check_ids).toEqual(['check_1'])

      const inspected = await executeTool(ctx, 'inspect_memory', {}, agent) as Record<string, unknown>
      const acceptance = inspected.acceptance as Record<string, unknown>
      expect(acceptance.check_count).toBe(1)
      expect(acceptance.active_count).toBe(1)
      expect(acceptance.invoked_count).toBe(2)
      expect(acceptance.passed_count).toBe(1)
      expect(acceptance.violated_count).toBe(1)
      const audits = inspected.recent_audits as { audit_id: string; verdict: string }[]
      expect(audits.map(audit => audit.verdict)).toEqual(['verified', 'violated', 'not-applicable'])

      // Persistence round-trip through the same files the service wrote.
      const store = new CognitiveStore(root)
      await store.load()
      expect(store.acceptanceSnapshot().length).toBe(1)
      expect(store.claimAuditsSnapshot().length).toBe(3)
      const check = store.acceptanceSnapshot()[0]!
      expect(check.invokedCount).toBe(2)
      expect(check.passedCount).toBe(1)
      expect(check.violatedCount).toBe(1)
    } finally {
      await teardown()
    }
  })

  it('folds prediction error into violated criteria on report (验收回流)', async () => {
    const { ctx, teardown } = await pipelineHarness()
    try {
      const { agent } = stubAgent('acceptance-feedback-agent')
      ctx.agents.register(agent)
      await ctx.cognitivePipeline.defineAcceptanceCheck({
        criterion: '声称完成前必须给出证据来源',
        trigger: '声称完成',
        evidenceHint: '引用具体证据',
      })
      const pred = await ctx.cognitivePipeline.predict({ situation: '实现验收清单', action: '声称完成' })
      const audit = await ctx.cognitivePipeline.auditClaim({
        claim: '验收清单已实现，声称完成',
        situation: '实现验收清单',
        predictionId: pred.predictionId,
      })
      expect(audit.verdict).toBe('violated')
      await ctx.cognitivePipeline.report({
        predictionId: pred.predictionId,
        actualOutcome: '实际未通过验收',
        outcomeQuality: 3,
      })
      const check = ctx.cognitivePipeline.store.getAcceptanceCheck('check_1')!
      const error = Math.abs(pred.calibratedProbability - 0.3)
      expect(check.cumulativeError).toBeCloseTo(error, 5)
      expect(check.errorFoldCount).toBe(1)
    } finally {
      await teardown()
    }
  })

  it('flags rework once per threshold crossing and records one deviation meta experience', async () => {
    const { ctx, teardown } = await pipelineHarness()
    try {
      const { agent } = stubAgent('acceptance-gate-agent')
      ctx.agents.register(agent)
      await ctx.cognitivePipeline.defineAcceptanceCheck({
        criterion: '声称完成前必须给出证据来源',
        trigger: '声称完成',
        evidenceHint: '引用具体证据',
      })
      // Two violations: invoked=2 < acceptanceMinEvidenceCount=3 → no rework.
      for (let index = 0; index < 2; index += 1) {
        const audit = await ctx.cognitivePipeline.auditClaim({ claim: '声称完成某功能', situation: '实现中' })
        expect(audit.reworkNeeded).toBe(false)
      }
      // Third violation crosses invoked≥3 and deviation 3/3=1.0 ≥ 0.5.
      const crossing = await ctx.cognitivePipeline.auditClaim({ claim: '声称完成全部功能', situation: '实现中' })
      expect(crossing.reworkNeeded).toBe(true)
      expect(crossing.deviationExpId).not.toBeNull()
      const metaExps = ctx.cognitivePipeline.store.experiencesSnapshot().filter(exp => exp.meta === true)
      expect(metaExps.length).toBe(1)
      expect(metaExps[0]!.sar.situation).toContain('验收准则持续被违反')
      // The fourth audit is already past the crossing: no duplicate meta record.
      const again = await ctx.cognitivePipeline.auditClaim({ claim: '声称完成收尾', situation: '实现中' })
      expect(again.reworkNeeded).toBe(false)
      expect(again.deviationExpId).toBeNull()
      expect(ctx.cognitivePipeline.store.experiencesSnapshot().filter(exp => exp.meta === true).length).toBe(1)
      // inspect keeps listing the crossed criterion as a rewrite/retire candidate.
      const stats = ctx.cognitivePipeline.inspect().acceptance
      expect(stats.reworkCheckIds).toEqual(['check_1'])
      expect(stats.deviationRate).toBe(1)
    } finally {
      await teardown()
    }
  })

  it('rewrites active criteria but freezes retired ones', async () => {
    const { ctx, teardown } = await pipelineHarness()
    try {
      await ctx.cognitivePipeline.defineAcceptanceCheck({
        criterion: '原准则',
        trigger: 't1',
        evidenceHint: '证据提示',
      })
      const rewritten = await ctx.cognitivePipeline.updateAcceptanceCheck({
        checkId: 'check_1',
        criterion: '重写后的准则',
      })
      expect(rewritten.criterion).toBe('重写后的准则')
      expect(rewritten.revision).toBe(2)
      // The evidence ledger is preserved across rewrites.
      await ctx.cognitivePipeline.auditClaim({ claim: 't1 声称', situation: 'x' })
      const retired = await ctx.cognitivePipeline.updateAcceptanceCheck({ checkId: 'check_1', retire: true })
      expect(retired.status).toBe('retired')
      expect(retired.revision).toBe(3)
      await expect(ctx.cognitivePipeline.updateAcceptanceCheck({ checkId: 'check_1', criterion: 'x' }))
        .rejects.toThrow(/retired and frozen/)
      // Retired criteria are no longer applied by audits.
      const audit = await ctx.cognitivePipeline.auditClaim({ claim: 't1 声称', situation: 'x' })
      expect(audit.verdict).toBe('not-applicable')
      expect(audit.appliedCheckIds).toEqual([])
    } finally {
      await teardown()
    }
  })
})
