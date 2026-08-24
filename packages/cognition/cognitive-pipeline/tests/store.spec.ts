import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  VariantCandidate,
} from '../src/types.ts'
import { actionVector, outcomeVector } from '../src/vectorizer.ts'

function variantCandidate(variantId: string, status: VariantCandidate['status'] = 'proposed'): VariantCandidate {
  const now = Date.now()
  return {
    variantId,
    sourceStrategyId: 'solidified-1',
    sourceExpId: null,
    baseAction: '原行动',
    variantAction: '扰动后的行动',
    verificationAnchor: 'logs/restart-result.json ok=true',
    perturbedAspect: '前置校验',
    rationale: '增加端口预检',
    status,
    settlements: [],
    createdAt: now,
    updatedAt: now,
  }
}

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
    simulated: false,
    verification: 'verified',
    evidenceScore: 0,
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
    exploredActionHash: null,
    timestamp: Date.now(),
    actualOutcome: null,
    predictionError: null,
    resolvedAt: null,
    fusion: null,
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

  it('round-trips the learned channel weights and clamps hostile values on load', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cognition-store-'))
    try {
      const first = new CognitiveStore(dir)
      await first.load()
      first.updateChannelWeights({ semantic: 2.5, situational: 0.4, symptom: 1.8, outcome: 0.3 })
      await first.flush()

      const second = new CognitiveStore(dir)
      await second.load()
      expect(second.channelWeightsSnapshot()).toEqual({ semantic: 2.5, situational: 0.4, symptom: 1.8, outcome: 0.3 })

      // A hostile weights file is clamped into the learnable band [0.2, 3].
      writeFileSync(join(dir, 'channel_weights.json'), JSON.stringify({ semantic: 99, situational: -5, symptom: 'x', outcome: 1 }))
      const third = new CognitiveStore(dir)
      await third.load()
      expect(third.channelWeightsSnapshot()).toEqual({ semantic: 3, situational: 0.2, symptom: 1, outcome: 1 })
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

  it('folds feedback quality into the bound experience utility label', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cognition-store-'))
    try {
      const store = new CognitiveStore(dir)
      await store.load()
      // A neutral experience (5/5/5) bound to a prediction.
      const exp = experience('exp_1', 5)
      store.addExperience(exp)
      store.addPrediction(prediction('pred_1', 0.5, 'exp_1'))
      // High-quality feedback: the neutral experience must gain a real label.
      store.resolvePrediction('pred_1', '结果很好', 0.3, 8)
      const labeled = store.getExperience('exp_1')
      // 5 + (8-5)*0.8 = 7.4 → rounded 7.4, material gain now positive.
      expect(labeled?.sar.outcomeUtility.materialGain).toBeGreaterThan(5)
      expect(labeled?.sar.outcomeUtility.materialGain).toBeLessThan(8)
      // Valence and cost are not conveyed by feedback and stay put.
      expect(labeled?.sar.outcomeUtility.emotionalValence).toBe(5)
      expect(labeled?.sar.outcomeUtility.energyCost).toBe(5)

      // Low-quality feedback moves the label the other way.
      store.addExperience(experience('exp_2', 5))
      store.addPrediction(prediction('pred_2', 0.5, 'exp_2'))
      store.resolvePrediction('pred_2', '结果很差', 0.3, 2)
      const negative = store.getExperience('exp_2')
      expect(negative?.sar.outcomeUtility.materialGain).toBeLessThan(5)

      // No quality: the label is untouched.
      store.addExperience(experience('exp_3', 5))
      store.addPrediction(prediction('pred_3', 0.5, 'exp_3'))
      store.resolvePrediction('pred_3', '结果未知', 0.3)
      expect(store.getExperience('exp_3')?.sar.outcomeUtility.materialGain).toBe(5)

      // Quality-carrying settlements append variance-ledger samples: the raw
      // quality is kept un-scaled and multiple samples accumulate.
      const settled = store.getExperience('exp_1')
      expect(settled?.settlements).toHaveLength(1)
      expect(settled?.settlements?.[0]?.quality).toBe(8)
      expect(settled?.settlements?.[0]?.ts).toBeGreaterThan(0)
      // A second settlement on the same experience appends, not overwrites.
      store.addPrediction(prediction('pred_4', 0.5, 'exp_1'))
      store.resolvePrediction('pred_4', '再来一次', 0.2, 6)
      expect(store.getExperience('exp_1')?.settlements).toHaveLength(2)
      expect(store.getExperience('exp_1')?.settlements?.[1]?.quality).toBe(6)
      // No-quality settlement leaves the ledger empty for that experience.
      expect(store.getExperience('exp_3')?.settlements).toBeUndefined()

      // The stats aggregate counts sampled and multi-sample experiences.
      const stats = store.stats()
      expect(stats.settlement.sampleCount).toBe(3)
      expect(stats.settlement.sampledExperienceCount).toBe(2)
      expect(stats.settlement.multiSampleExperienceCount).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('flags disequilibrium when a settlement deviates from the prior distribution', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cognition-store-'))
    try {
      const store = new CognitiveStore(dir)
      await store.load()
      // A stable prior (7,7,7,8) followed by a far sample (2): z ≈ 12 ≫ 2.
      const exp = experience('exp_1', 5)
      store.addExperience({ ...exp, settlements: [
        { ts: 1, quality: 7 }, { ts: 2, quality: 7 },
        { ts: 3, quality: 7 }, { ts: 4, quality: 8 },
      ] })
      store.addPrediction(prediction('pred_1', 0.5, 'exp_1'))
      store.resolvePrediction('pred_1', '结果崩溃', 0.4, 2)
      const flagged = store.getExperience('exp_1')
      expect(flagged?.settlements).toHaveLength(5)
      expect(flagged?.disequilibrium?.sampleQuality).toBe(2)
      expect(flagged?.disequilibrium?.zScore).toBeGreaterThan(2)

      // A sample within the prior's spread does not trigger the gate.
      const stable = experience('exp_2', 5)
      store.addExperience({ ...stable, settlements: [
        { ts: 1, quality: 7 }, { ts: 2, quality: 7 },
        { ts: 3, quality: 7 }, { ts: 4, quality: 8 },
      ] })
      store.addPrediction(prediction('pred_2', 0.5, 'exp_2'))
      store.resolvePrediction('pred_2', '结果正常', 0.1, 7)
      expect(store.getExperience('exp_2')?.disequilibrium).toBeUndefined()

      // A too-thin prior (2 samples) carries no variance signal: no judgment.
      const thin = experience('exp_3', 5)
      store.addExperience({ ...thin, settlements: [{ ts: 1, quality: 7 }, { ts: 2, quality: 8 }] })
      store.addPrediction(prediction('pred_3', 0.5, 'exp_3'))
      store.resolvePrediction('pred_3', '结果异常', 0.4, 1)
      expect(store.getExperience('exp_3')?.disequilibrium).toBeUndefined()

      // The aggregate counts exactly the flagged experience.
      const stats = store.stats()
      expect(stats.settlement.sampleCount).toBe(5 + 5 + 3)
      expect(stats.settlement.disequilibratedExperienceCount).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves a flagged disequilibrium when a later settlement returns toward the mean', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cognition-store-'))
    try {
      const store = new CognitiveStore(dir)
      await store.load()
      // Stable prior (7,7,7,8); a far sample (2) flags disequilibrium.
      store.addExperience({ ...experience('exp_1', 5), settlements: [
        { ts: 1, quality: 7 }, { ts: 2, quality: 7 },
        { ts: 3, quality: 7 }, { ts: 4, quality: 8 },
      ] })
      store.addPrediction(prediction('pred_1', 0.5, 'exp_1'))
      store.resolvePrediction('pred_1', '结果崩溃', 0.4, 2)
      const flagged = store.getExperience('exp_1')
      expect(flagged?.disequilibrium).toBeDefined()
      expect(flagged?.disequilibriumRecoveredAt).toBeUndefined()

      // A later settlement closer to the mean (6, vs the deviating 2) resolves
      // the flag — the shift was transient, the memory comes back.
      store.addPrediction(prediction('pred_2', 0.5, 'exp_1'))
      store.resolvePrediction('pred_2', '结果回归', 0.1, 6)
      const recovered = store.getExperience('exp_1')
      expect(recovered?.disequilibriumRecoveredAt).toBeGreaterThan(0)
      // The event stays as audit history; only the resolution marker is added.
      expect(recovered?.disequilibrium?.sampleQuality).toBe(2)

      // A still-deviating sample (farther from the mean than the deviant one)
      // does NOT resolve an active flag.
      store.addExperience({ ...experience('exp_2', 5), settlements: [
        { ts: 1, quality: 7 }, { ts: 2, quality: 7 },
        { ts: 3, quality: 7 }, { ts: 4, quality: 8 },
      ] })
      store.addPrediction(prediction('pred_3', 0.5, 'exp_2'))
      store.resolvePrediction('pred_3', '结果崩溃', 0.4, 2)
      store.addPrediction(prediction('pred_4', 0.5, 'exp_2'))
      store.resolvePrediction('pred_4', '继续崩溃', 0.4, 1)
      expect(store.getExperience('exp_2')?.disequilibriumRecoveredAt).toBeUndefined()

      // Stats split active vs recovered.
      const stats = store.stats()
      expect(stats.settlement.disequilibratedExperienceCount).toBe(1)
      expect(stats.settlement.recoveredDisequilibriumCount).toBe(1)
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
        polarity: 'success',
        situationCentroid: actionVector('情境exp_1 情境exp_2', []),
      }
      const taxonomy: TaxonomyState = {
        version: 1,
        summaryShort: '重组为1簇',
        rules: [{ condition: '正向簇', action: '沿用', utilityRange: { low: 6, high: 10 }, polarity: 'success' }],
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

  it('normalizes pre-polarity cluster and taxonomy rows on load', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cognition-store-'))
    try {
      const store = new CognitiveStore(dir)
      await store.load()
      store.addExperience(experience('exp_1', 8))
      // Simulate an old on-disk cluster without the polarity / situationCentroid fields.
      const legacy: Cluster = {
        clusterId: 1,
        name: '旧簇',
        decisionRule: 'if 相似 then 沿用',
        expectedUtilityRange: { low: 7, high: 10 },
        supportingEvidenceIds: ['exp_1'],
        fallbackAction: '观察',
        createdAt: Date.now(),
        origin: 'cold-loop',
        sampleCount: 1,
        cumPredictionError: 0,
      } as unknown as Cluster
      store.applyTaxonomy([legacy], {
        version: 1,
        summaryShort: '旧',
        rules: [{ condition: '旧簇', action: '沿用', utilityRange: { low: 7, high: 10 }, polarity: 'success' }],
        updatedAt: Date.now(),
      }, new Map([['exp_1', { clusterId: 1, strategyLabel: '旧簇' }]]))
      await store.flush()

      const reloaded = new CognitiveStore(dir)
      await reloaded.load()
      const cluster = reloaded.clustersSnapshot()[0]
      expect(cluster?.polarity).toBe('success')
      expect(cluster?.situationCentroid.length).toBeGreaterThan(0)
      const taxonomy = reloaded.taxonomySnapshot()
      expect(taxonomy?.rules[0]?.polarity).toBe('success')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('drives simulated verification through the evidence-replacement state machine', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cognition-store-'))
    try {
      const store = new CognitiveStore(dir)
      await store.load()
      // A simulated experience starts unverified.
      const simulated: Experience = {
        ...experience('exp_1', 6),
        simulated: true,
        verification: 'unverified',
        evidenceScore: 0,
      }
      store.addExperience(simulated)

      // A single decisive weight fast-tracks to provisional.
      store.applyFeedbackEvidence('exp_1', 0.9, false, 0.8, 2)
      expect(store.getExperience('exp_1')?.verification).toBe('provisional')
      expect(store.getExperience('exp_1')?.evidenceScore).toBe(0.9)

      // Cumulative evidence reaches the permanent threshold → verified.
      store.applyFeedbackEvidence('exp_1', 0.6, false, 0.8, 2)
      store.applyFeedbackEvidence('exp_1', 0.6, false, 0.8, 2)
      expect(store.getExperience('exp_1')?.verification).toBe('verified')

      // A fresh simulation: contradictory feedback at provisional rolls back.
      const second: Experience = {
        ...experience('exp_2', 6),
        simulated: true,
        verification: 'unverified',
        evidenceScore: 0,
      }
      store.addExperience(second)
      store.applyFeedbackEvidence('exp_2', 0.9, false, 0.8, 2)
      expect(store.getExperience('exp_2')?.verification).toBe('provisional')
      store.applyFeedbackEvidence('exp_2', 0.5, true, 0.8, 2)
      expect(store.getExperience('exp_2')?.verification).toBe('unverified')
      expect(store.getExperience('exp_2')?.evidenceScore).toBe(0)

      // Ordinary experiences are verified by construction and never touched.
      store.applyFeedbackEvidence('exp_1', 0.9, false, 0.8, 2)
      expect(store.getExperience('exp_1')?.verification).toBe('verified')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('expires unverified simulated experiences past the fallback TTL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cognition-store-'))
    try {
      const store = new CognitiveStore(dir)
      await store.load()
      const old: Experience = {
        ...experience('exp_1', 6),
        simulated: true,
        verification: 'unverified',
        evidenceScore: 0,
        timestamp: Date.now() - 10 * 24 * 60 * 60 * 1000, // 10 days old
      }
      const fresh: Experience = {
        ...experience('exp_2', 6),
        simulated: true,
        verification: 'unverified',
        evidenceScore: 0,
        timestamp: Date.now(),
      }
      const verifiedSim: Experience = {
        ...experience('exp_3', 6),
        simulated: true,
        verification: 'verified',
        evidenceScore: 3,
        timestamp: Date.now() - 10 * 24 * 60 * 60 * 1000,
      }
      store.addExperience(old)
      store.addExperience(fresh)
      store.addExperience(verifiedSim)

      const expired = store.expireUnverifiedSimulated(Date.now(), 7 * 24 * 60 * 60 * 1000)
      expect(expired).toEqual(['exp_1'])
      expect(store.getExperience('exp_1')).toBeUndefined()
      expect(store.getExperience('exp_2')).toBeDefined()
      // Verified simulations are never TTL-expired.
      expect(store.getExperience('exp_3')).toBeDefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('folds reuse errors into an exploration entry with EWMA and persists validated state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cognition-store-'))
    try {
      const first = new CognitiveStore(dir)
      await first.load()
      first.recordExploration({
        ts: Date.now(),
        action: '试探行动',
        scratchpadHash: 'h1',
        reversible: true,
        outcome: 'graduated',
        validatedError: null,
        validated: null,
      })
      // First fold seeds the EWMA; second fold moves it toward the new error.
      first.validateExploration('h1', 0.4, 0.5, 0.3)
      const afterFirst = first.explorationSnapshot().entries[0]
      expect(afterFirst?.validatedError).toBe(0.4)
      expect(afterFirst?.validated).toBe(false)
      first.validateExploration('h1', 0.1, 0.5, 0.3)
      const afterSecond = first.explorationSnapshot().entries[0]
      expect(afterSecond?.validatedError).toBeCloseTo(0.25)
      expect(afterSecond?.validated).toBe(true)
      await first.flush()

      // The validated ledger survives reload.
      const second = new CognitiveStore(dir)
      await second.load()
      const reloaded = second.explorationSnapshot().entries[0]
      expect(reloaded?.outcome).toBe('graduated')
      expect(reloaded?.validatedError).toBeCloseTo(0.25)
      expect(reloaded?.validated).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves the exploration ledger untouched for an unknown scratchpad hash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cognition-store-'))
    try {
      const store = new CognitiveStore(dir)
      await store.load()
      store.recordExploration({
        ts: Date.now(),
        action: '试探行动',
        scratchpadHash: 'h1',
        reversible: true,
        outcome: null,
        validatedError: null,
        validated: null,
      })
      const result = store.validateExploration('missing', 0.2, 0.5, 0.3)
      expect(result).toBeUndefined()
      expect(store.explorationSnapshot().entries[0]?.validatedError).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('normalizes legacy exploration files that predate the validation fields', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cognition-store-'))
    try {
      // Write a legacy exploration.json without validatedError/validated.
      writeFileSync(join(dir, 'exploration.json'), JSON.stringify({
        date: '2026-08-21',
        used: 1,
        entries: [{ ts: Date.now(), action: '旧试探', scratchpadHash: 'legacy', reversible: true, outcome: 'graduated' }],
      }), 'utf8')
      const store = new CognitiveStore(dir)
      await store.load()
      const entry = store.explorationSnapshot().entries[0]
      expect(entry?.scratchpadHash).toBe('legacy')
      expect(entry?.validatedError).toBeNull()
      expect(entry?.validated).toBeNull()
      // A fold now works on the normalized entry instead of producing NaN.
      store.validateExploration('legacy', 0.2, 0.5, 0.3)
      expect(store.explorationSnapshot().entries[0]?.validatedError).toBe(0.2)
      expect(store.explorationSnapshot().entries[0]?.validated).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persists variant candidates and their lifecycle transitions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cognition-store-'))
    try {
      const store = new CognitiveStore(dir)
      await store.load()
      // Real flow: allocate the id first, then persist the candidate.
      const first = { ...variantCandidate(store.nextVariantId()) }
      store.addVariantCandidate(first)
      const second = { ...variantCandidate(store.nextVariantId(), 'testing') }
      store.addVariantCandidate(second)
      // Lifecycle transition: proposed → adopted, with a settlement appended.
      store.updateVariantCandidate({
        ...first,
        status: 'adopted',
        settlements: [{ ts: Date.now(), quality: 8 }],
        updatedAt: Date.now(),
      })

      // Sequence advances across allocations.
      expect(store.nextVariantId()).toBe('variant-3')

      // Persistence round-trip through the same files the service wrote.
      await store.flush()
      const reloaded = new CognitiveStore(dir)
      await reloaded.load()
      const all = reloaded.variantsSnapshot()
      expect(all).toHaveLength(2)
      const adopted = all.find(candidate => candidate.variantId === 'variant-1')
      expect(adopted?.status).toBe('adopted')
      expect(adopted?.settlements).toHaveLength(1)
      expect(all.find(candidate => candidate.variantId === 'variant-2')?.status).toBe('testing')
      expect(reloaded.nextVariantId()).toBe('variant-3')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('removes an experience and folds its citation stats (lifecycle prune)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cognition-store-'))
    try {
      const store = new CognitiveStore(dir)
      await store.load()
      store.addExperience({ ...experience('exp_1', 8), timestamp: Date.now() - 40 * 24 * 60 * 60 * 1000 })
      store.addExperience({ ...experience('exp_2', 8), citationCount: 2 })
      expect(store.removeExperience('exp_1')).toBe(true)
      expect(store.removeExperience('exp_1')).toBe(false)
      await store.flush()
      const stats = store.stats()
      expect(stats.citation.citedExperienceCount).toBe(1)
      expect(stats.citation.zeroCitationExperienceCount).toBe(0)
      // Persistence round-trip reflects the removal.
      const reloaded = new CognitiveStore(dir)
      await reloaded.load()
      expect(reloaded.experiencesSnapshot().map(exp => exp.expId)).toEqual(['exp_2'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
