/**
 * Focused invariant coverage for `@deepseek-ai/dsh-cognitive-pipeline`.
 * The invariant companion iterates live store snapshots at install time, so
 * this suite seeds data before mounting the registry — the auto-invariant host
 * would mount the companion against an empty store and never exercise the
 * loop bodies. The file name opts into the manual invariant tree.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import * as CognitivePipeline from '@deepseek-ai/dsh-cognitive-pipeline'
import * as InvariantCompanion from '@deepseek-ai/dsh-cognitive-pipeline/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { actionVector, outcomeVector } from '@deepseek-ai/dsh-cognitive-pipeline/src/vectorizer.ts'

/** Build a pipeline service with a seeded store, then mount the invariant. */
async function pipelineCtx(root: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(CognitivePipeline, { root, enabled: false })
  return ctx
}

/** Build a pipeline service with a seeded store, then mount the invariant. */
async function setup(): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const root = mkdtempSync(join(tmpdir(), 'cognition-invariant-'))
  const ctx = await pipelineCtx(root)
  const service = ctx.cognitivePipeline

  service.store.addExperience({
    expId: 'exp_1',
    sar: {
      situation: '清晨',
      action: '晨跑',
      outcome: '精力充沛',
      actionKeywords: ['晨跑'],
      outcomeUtility: { materialGain: 8, emotionalValence: 7, energyCost: 3 },
    },
    actionVector: actionVector('晨跑', []),
    outcomeVector: outcomeVector({ materialGain: 8, emotionalValence: 7, energyCost: 3 }, '精力充沛'),
    clusterId: 1,
    strategyLabel: '清晨运动簇',
    timestamp: Date.now(),
    predictionError: 0.2,
    cumulativeError: 0.4,
    hitCount: 1,
    positiveCount: 1,
    simulated: false,
    verification: 'verified',
    evidenceScore: 0,
  })
  service.store.addPrediction({
    predictionId: 'pred_1',
    expId: 'exp_1',
    situation: '清晨',
    action: '晨跑',
    predictedOutcome: '成功',
    rawProbability: 0.7,
    calibratedProbability: 0.7,
    confidenceLow: 0.5,
    confidenceHigh: 0.9,
    isNovel: false,
    usedTempStrategy: false,
    clusterId: 1,
    timestamp: Date.now(),
    actualOutcome: '成功',
    predictionError: 0.2,
    resolvedAt: Date.now(),
    fusion: null,
  })
  // A success cluster whose situation centroid matches the seeded experience.
  service.store.applyTaxonomy(
    [{
      clusterId: 1,
      name: '清晨运动簇',
      decisionRule: 'if 清晨 then 坚持晨跑',
      expectedUtilityRange: { low: 6, high: 10 },
      supportingEvidenceIds: ['exp_1'],
      fallbackAction: '适度运动',
      createdAt: Date.now(),
      origin: 'cold-loop',
      sampleCount: 1,
      cumPredictionError: 0.2,
      polarity: 'success',
      situationCentroid: actionVector('清晨', []),
    }],
    {
      version: 1,
      summaryShort: '清晨运动簇',
      rules: [{ condition: '清晨运动簇', action: '坚持晨跑', utilityRange: { low: 6, high: 10 }, polarity: 'success' }],
      updatedAt: Date.now(),
    },
    new Map([['exp_1', { clusterId: 1, strategyLabel: '清晨运动簇' }]]),
  )

  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(InvariantCompanion)
  return {
    ctx,
    dispose: async () => {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

describe('cognitive-pipeline invariants', () => {
  it('accepts a canonical store: in-range probabilities, full-dimension vectors, valid clusters', async () => {
    const { ctx, dispose } = await setup()
    try {
      // The companion mounted without throwing: every seeded row passed the checks.
      expect(ctx.invariants).toBeDefined()
    } finally {
      await dispose()
    }
  })

  it('rejects a prediction whose calibrated probability falls outside [0, 1]', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cognition-invariant-bad-pred-'))
    try {
      const ctx = await pipelineCtx(root)
      ctx.cognitivePipeline.store.addPrediction({
        predictionId: 'pred_bad',
        expId: null,
        situation: 's',
        action: 'a',
        predictedOutcome: 'p',
        rawProbability: 1.2,
        calibratedProbability: 1.2,
        confidenceLow: 1,
        confidenceHigh: 1,
        isNovel: false,
        usedTempStrategy: false,
        clusterId: null,
        timestamp: Date.now(),
        actualOutcome: null,
        predictionError: null,
        resolvedAt: null,
        fusion: null,
      })
      await ctx.plugin(InvariantRegistry, { enabled: true })
      await expect(ctx.plugin(InvariantCompanion))
        .rejects.toMatchObject({ code: 'INVARIANT' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a prediction whose confidence interval is inverted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cognition-invariant-bad-interval-'))
    try {
      const ctx = await pipelineCtx(root)
      ctx.cognitivePipeline.store.addPrediction({
        predictionId: 'pred_bad',
        expId: null,
        situation: 's',
        action: 'a',
        predictedOutcome: 'p',
        rawProbability: 0.5,
        calibratedProbability: 0.5,
        confidenceLow: 0.9,
        confidenceHigh: 0.1,
        isNovel: false,
        usedTempStrategy: false,
        clusterId: null,
        timestamp: Date.now(),
        actualOutcome: null,
        predictionError: null,
        resolvedAt: null,
        fusion: null,
      })
      await ctx.plugin(InvariantRegistry, { enabled: true })
      await expect(ctx.plugin(InvariantCompanion))
        .rejects.toMatchObject({ code: 'INVARIANT' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a cluster whose situation centroid has the wrong dimension', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cognition-invariant-bad-cluster-'))
    try {
      const ctx = await pipelineCtx(root)
      ctx.cognitivePipeline.store.addExperience({
        expId: 'exp_1',
        sar: {
          situation: '清晨',
          action: '晨跑',
          outcome: '精力充沛',
          actionKeywords: ['晨跑'],
          outcomeUtility: { materialGain: 8, emotionalValence: 7, energyCost: 3 },
        },
        actionVector: actionVector('晨跑', []),
        outcomeVector: outcomeVector({ materialGain: 8, emotionalValence: 7, energyCost: 3 }, '精力充沛'),
        clusterId: null,
        strategyLabel: null,
        timestamp: Date.now(),
        predictionError: null,
        cumulativeError: 0,
        hitCount: 0,
        positiveCount: 0,
        simulated: false,
        verification: 'verified',
        evidenceScore: 0,
      })
      ctx.cognitivePipeline.store.applyTaxonomy(
        [{
          clusterId: 2,
          name: '坏簇',
          decisionRule: 'if x then y',
          expectedUtilityRange: { low: 0, high: 10 },
          supportingEvidenceIds: ['exp_1'],
          fallbackAction: '观察',
          createdAt: Date.now(),
          origin: 'cold-loop',
          sampleCount: 1,
          cumPredictionError: 0,
          polarity: 'success',
          situationCentroid: [1, 2, 3],
        }],
        {
          version: 2,
          summaryShort: '坏簇',
          rules: [],
          updatedAt: Date.now(),
        },
        new Map(),
      )
      await ctx.plugin(InvariantRegistry, { enabled: true })
      await expect(ctx.plugin(InvariantCompanion))
        .rejects.toMatchObject({ code: 'INVARIANT' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects an experience whose action vector has the wrong dimension', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cognition-invariant-bad-vector-'))
    try {
      const ctx = await pipelineCtx(root)
      ctx.cognitivePipeline.store.addExperience({
        expId: 'exp_1',
        sar: {
          situation: '清晨',
          action: '晨跑',
          outcome: '精力充沛',
          actionKeywords: ['晨跑'],
          outcomeUtility: { materialGain: 8, emotionalValence: 7, energyCost: 3 },
        },
        actionVector: [1, 2, 3],
        outcomeVector: outcomeVector({ materialGain: 8, emotionalValence: 7, energyCost: 3 }, '精力充沛'),
        clusterId: null,
        strategyLabel: null,
        timestamp: Date.now(),
        predictionError: null,
        cumulativeError: 0,
        hitCount: 0,
        positiveCount: 0,
        simulated: false,
        verification: 'verified',
        evidenceScore: 0,
      })
      await ctx.plugin(InvariantRegistry, { enabled: true })
      await expect(ctx.plugin(InvariantCompanion))
        .rejects.toMatchObject({ code: 'INVARIANT' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects an experience whose outcome vector has the wrong dimension', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cognition-invariant-bad-outcome-vector-'))
    try {
      const ctx = await pipelineCtx(root)
      ctx.cognitivePipeline.store.addExperience({
        expId: 'exp_1',
        sar: {
          situation: '清晨',
          action: '晨跑',
          outcome: '精力充沛',
          actionKeywords: ['晨跑'],
          outcomeUtility: { materialGain: 8, emotionalValence: 7, energyCost: 3 },
        },
        actionVector: actionVector('晨跑', []),
        outcomeVector: [1, 2, 3],
        clusterId: null,
        strategyLabel: null,
        timestamp: Date.now(),
        predictionError: null,
        cumulativeError: 0,
        hitCount: 0,
        positiveCount: 0,
        simulated: false,
        verification: 'verified',
        evidenceScore: 0,
      })
      await ctx.plugin(InvariantRegistry, { enabled: true })
      await expect(ctx.plugin(InvariantCompanion))
        .rejects.toMatchObject({ code: 'INVARIANT' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
