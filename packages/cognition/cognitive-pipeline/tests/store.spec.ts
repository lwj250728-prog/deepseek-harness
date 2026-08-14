import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CognitiveStore } from '../src/store.ts'
import type {
  CalibrationBucket,
  Cluster,
  Experience,
  Prediction,
  TaxonomyState,
  TempStrategy,
} from '../src/types.ts'
import { actionVector, outcomeVector } from '../src/vectorizer.ts'

function experience(expId: string, materialGain: number): Experience {
  return {
    expId,
    sar: {
      situation: `情境${expId}`,
      action: `行动${expId}`,
      outcome: '结果',
      actionKeywords: ['行动'],
      outcomeUtility: { materialGain, emotionalValence: 5, energyCost: 5 },
    },
    actionVector: actionVector(`行动${expId}`, ['行动']),
    outcomeVector: outcomeVector({ materialGain, emotionalValence: 5, energyCost: 5 }, '结果'),
    clusterId: null,
    strategyLabel: null,
    timestamp: Date.now(),
    predictionError: null,
    cumulativeError: 0,
    hitCount: 0,
    positiveCount: 0,
  }
}

function prediction(predictionId: string, probability: number, expId: string | null): Prediction {
  return {
    predictionId,
    expId,
    situation: 's',
    action: 'a',
    predictedOutcome: 'p',
    rawProbability: probability,
    calibratedProbability: probability,
    confidenceLow: Math.max(0, probability - 0.1),
    confidenceHigh: Math.min(1, probability + 0.1),
    isNovel: false,
    usedTempStrategy: false,
    clusterId: null,
    timestamp: Date.now(),
    actualOutcome: null,
    predictionError: null,
    resolvedAt: null,
  }
}

function tempStrategy(hash: string): TempStrategy {
  return {
    signatureHash: hash,
    trialAction: '试探行动',
    pendingResult: null,
    hitCount: 1,
    positiveCount: 0,
    createdAt: Date.now(),
    expiresAt: Date.now() + 86_400_000,
    status: 'active',
    sourceExpId: null,
  }
}

describe('CognitiveStore', () => {
  it('round-trips experiences, predictions, temp strategies, and calibration through the filesystem', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cognition-store-'))
    try {
      const first = new CognitiveStore(dir)
      await first.load()
      const exp = experience('exp_1', 8)
      first.addExperience(exp)
      first.addPrediction(prediction('pred_1', 0.6, 'exp_1'))
      first.addTempStrategy(tempStrategy('abc'))
      first.recordCalibration(0.65, true)
      first.recordCalibration(0.65, false)
      await first.flush()

      const second = new CognitiveStore(dir)
      await second.load()
      expect(second.getExperience('exp_1')?.sar.outcomeUtility.materialGain).toBe(8)
      expect(second.getPrediction('pred_1')?.calibratedProbability).toBe(0.6)
      expect(second.getTempStrategy('abc')?.status).toBe('active')
      const buckets: readonly CalibrationBucket[] = second.calibrationBucketsSnapshot()
      const bucket = buckets[6]
      expect(bucket?.totalCount).toBe(2)
      expect(bucket?.hitCount).toBe(1)
      expect(bucket?.empiricalAccuracy).toBe(0.5)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('propagates resolved prediction errors to the bound experience', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cognition-store-'))
    try {
      const store = new CognitiveStore(dir)
      await store.load()
      store.addExperience(experience('exp_1', 8))
      store.addPrediction(prediction('pred_1', 0.8, 'exp_1'))
      const resolved = store.resolvePrediction('pred_1', '成功了', 0.3)
      expect(resolved.resolvedAt).not.toBeNull()
      expect(resolved.predictionError).toBe(0.3)
      const exp = store.getExperience('exp_1')
      expect(exp?.predictionError).toBe(0.3)
      expect(exp?.cumulativeError).toBe(0.3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('applies a new taxonomy atomically and reassigns members', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cognition-store-'))
    try {
      const store = new CognitiveStore(dir)
      await store.load()
      store.addExperience(experience('exp_1', 8))
      store.addExperience(experience('exp_2', 8))
      store.addExperience(experience('exp_3', 2))
      const clusterA: Cluster = {
        clusterId: 1,
        name: '正向簇',
        decisionRule: 'if 相似 then 沿用',
        expectedUtilityRange: { low: 6, high: 10 },
        supportingEvidenceIds: ['exp_1', 'exp_2'],
        fallbackAction: '观察',
        createdAt: Date.now(),
        origin: 'cold-loop',
        sampleCount: 2,
        cumPredictionError: 0.2,
      }
      const taxonomy: TaxonomyState = {
        version: 1,
        summaryShort: '重组为1簇',
        rules: [{ condition: '正向簇', action: '沿用', utilityRange: { low: 6, high: 10 } }],
        updatedAt: Date.now(),
      }
      store.applyTaxonomy([clusterA], taxonomy, new Map([
        ['exp_1', { clusterId: 1, strategyLabel: '正向簇' }],
        ['exp_2', { clusterId: 1, strategyLabel: '正向簇' }],
      ]))
      await store.flush()
      expect(store.getExperience('exp_1')?.clusterId).toBe(1)
      expect(store.getExperience('exp_2')?.strategyLabel).toBe('正向簇')
      expect(store.getExperience('exp_3')?.clusterId).toBeNull()
      expect(store.taxonomySnapshot()?.version).toBe(1)

      const reloaded = new CognitiveStore(dir)
      await reloaded.load()
      expect(reloaded.clustersSnapshot()).toHaveLength(1)
      expect(reloaded.taxonomySnapshot()?.summaryShort).toBe('重组为1簇')
      expect(reloaded.getExperience('exp_1')?.clusterId).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('expires active temp strategies past their TTL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cognition-store-'))
    try {
      const store = new CognitiveStore(dir)
      await store.load()
      store.addTempStrategy(tempStrategy('old'))
      const expired = store.expireTempStrategies(Date.now() + 86_400_001)
      expect(expired).toEqual(['old'])
      expect(store.getTempStrategy('old')?.status).toBe('expired')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('generates monotonic experience and prediction ids', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cognition-store-'))
    try {
      const store = new CognitiveStore(dir)
      await store.load()
      expect(store.nextExpId()).toBe('exp_1')
      expect(store.nextExpId()).toBe('exp_2')
      expect(store.nextPredictionId()).toBe('pred_1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
