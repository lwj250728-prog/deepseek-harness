/**
 * Cold-loop engine: offline taxonomy reconstruction. Samples decay-weighted
 * high-error experiences, clusters them in utility space, anchors clusters
 * with LLM causal evidence (hard-constrained), backtests the proposal on the
 * newest slice, and atomically writes back only on a ≥15% error reduction.
 * @module @deepseek-ai/dsh-cognitive-pipeline/cold-engine
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { reconstructTaxonomy } from './llm.ts'
import type { CognitiveLlmRoute } from './llm.ts'
import { CognitiveStore } from './store.ts'
import type {
  Cluster,
  Experience,
  OutcomeUtility,
  RebuildResult,
  TaxonomyRule,
  TaxonomyState,
  TempStrategy,
} from './types.ts'
import { actionVector, cosine, outcomePolarity, outcomeVector, utilityScore } from './vectorizer.ts'

/** Fully resolved cold-loop thresholds (no optional fields). */
export interface ColdEngineConfig {
  readonly decayLambda: number
  readonly minDecayWeight: number
  readonly predictionErrorThreshold: number
  readonly successUtilityThreshold: number
  readonly maxSampleRatio: number
  readonly evidenceMinCount: number
  readonly evidenceMaxDistance: number
  readonly sandboxImprovement: number
  readonly validationRatio: number
  /** Minimum labeled (non-neutral) validation samples before a rebuild may be accepted. */
  readonly minValidationCount: number
  /** Extra reconstruct draws when one stochastic LLM sample yields nothing verified (default 2). */
  readonly reconstructRetries: number
  readonly clusterMergeCosine: number
  readonly clusterMatchCosine: number
}

/** One agglomerative cluster in progress. */
interface AggCluster {
  readonly memberIndices: readonly number[]
  readonly centroid: readonly number[]
  readonly meanUtility: OutcomeUtility
}

/** A candidate cluster with verified evidence and centroid. */
interface CandidateCluster {
  readonly name: string
  readonly decisionRule: string
  readonly expectedUtilityRange: { low: number; high: number }
  readonly evidenceIds: readonly string[]
  readonly fallbackAction: string
  readonly centroid: readonly number[]
  readonly meanUtility: OutcomeUtility
  /** Whether the cluster's mean utility marks it a success or risk pattern. */
  readonly polarity: 'success' | 'risk'
}

/** Normalized taxonomy view used by the backtest evaluator. */
interface TaxonomyView {
  readonly centroid: readonly number[]
  readonly meanUtility: OutcomeUtility
}

/** Mean of outcome utilities. */
function meanUtility(items: readonly Experience[]): OutcomeUtility {
  if (items.length === 0) return { materialGain: 5, emotionalValence: 5, energyCost: 5 }
  let materialGain = 0
  let emotionalValence = 0
  let energyCost = 0
  for (const item of items) {
    materialGain += item.sar.outcomeUtility.materialGain
    emotionalValence += item.sar.outcomeUtility.emotionalValence
    energyCost += item.sar.outcomeUtility.energyCost
  }
  return {
    materialGain: materialGain / items.length,
    emotionalValence: emotionalValence / items.length,
    energyCost: energyCost / items.length,
  }
}

/** Composite mean utility score (gains + valence − cost). */
function meanUtilityScore(utility: OutcomeUtility): number {
  return utilityScore(utility)
}

/** Centroid of outcome vectors, re-normalized. */
function centroidOf(vectors: readonly (readonly number[])[]): number[] {
  const dim = vectors[0]?.length ?? 0
  const sum = new Array<number>(dim).fill(0)
  for (const vector of vectors) {
    for (let index = 0; index < dim; index += 1) {
      sum[index] = (sum[index] ?? 0) + (vector[index] ?? 0)
    }
  }
  if (vectors.length === 0) return sum
  const mean = sum.map(value => value / vectors.length)
  let norm = 0
  for (const value of mean) norm += value * value
  norm = Math.sqrt(norm)
  return norm < 1e-9 ? mean : mean.map(value => value / norm)
}

/** Agglomerative clustering on outcome vectors (centroid linkage). */
function agglomerate(
  vectors: readonly (readonly number[])[],
  mergeCosine: number,
): AggCluster[] {
  const clusters: AggCluster[] = vectors.map(vector => ({
    memberIndices: [0],
    centroid: [...vector],
    meanUtility: { materialGain: 5, emotionalValence: 5, energyCost: 5 },
  }))
  // Track original indices through merges.
  const membersOf = vectors.map((_, index) => [index])
  for (;;) {
    let bestI = -1
    let bestJ = -1
    let bestScore = mergeCosine
    for (let i = 0; i < clusters.length; i += 1) {
      for (let j = i + 1; j < clusters.length; j += 1) {
        const a = clusters[i]?.centroid ?? []
        const b = clusters[j]?.centroid ?? []
        const score = cosine(a, b)
        if (score >= bestScore) {
          bestScore = score
          bestI = i
          bestJ = j
        }
      }
    }
    if (bestI < 0 || bestJ < 0) break
    const aMembers = membersOf[bestI] ?? []
    const bMembers = membersOf[bestJ] ?? []
    const mergedMembers = [...aMembers, ...bMembers]
    const mergedVectors = mergedMembers
      .map(index => vectors[index])
      .filter((vector): vector is readonly number[] => vector !== undefined)
    const merged: AggCluster = {
      memberIndices: mergedMembers,
      centroid: centroidOf(mergedVectors),
      meanUtility: { materialGain: 5, emotionalValence: 5, energyCost: 5 },
    }
    clusters.splice(bestJ, 1)
    clusters.splice(bestI, 1, merged)
    membersOf.splice(bestJ, 1)
    membersOf.splice(bestI, 1, mergedMembers)
  }
  return clusters.map((cluster, index) => ({
    memberIndices: membersOf[index] ?? cluster.memberIndices,
    centroid: cluster.centroid,
    meanUtility: cluster.meanUtility,
  }))
}

/** Verify the evidence hard constraint for one candidate cluster. */
function verifyEvidence(
  candidate: CandidateCluster,
  byId: ReadonlyMap<string, Experience>,
  minCount: number,
  maxDistance: number,
): { ok: boolean; reason: string } {
  if (candidate.evidenceIds.length < minCount) {
    return { ok: false, reason: `证据不足（${candidate.evidenceIds.length} < ${minCount}）` }
  }
  const evidence = candidate.evidenceIds.map(id => byId.get(id)).filter((exp): exp is Experience => exp !== undefined)
  if (evidence.length !== candidate.evidenceIds.length) {
    return { ok: false, reason: '支撑证据包含不存在的exp_id（幻觉因果）' }
  }
  let maxDistanceSeen = 0
  for (let i = 0; i < evidence.length; i += 1) {
    for (let j = i + 1; j < evidence.length; j += 1) {
      const distance = 1 - cosine((evidence[i] as Experience).outcomeVector, (evidence[j] as Experience).outcomeVector)
      maxDistanceSeen = Math.max(maxDistanceSeen, distance)
    }
  }
  if (maxDistanceSeen > maxDistance) {
    return { ok: false, reason: `证据间最大余弦距离 ${maxDistanceSeen.toFixed(3)} 超过阈值 ${maxDistance}` }
  }
  return { ok: true, reason: 'verified' }
}

/**
 * Cold-loop engine. `runRebuild` is the offline entry point; it never throws
 * for domain reasons — every outcome is a {@link RebuildResult}.
 */
export class ColdEngine {
  private readonly ctx: Context
  private readonly store: CognitiveStore
  private readonly config: ColdEngineConfig
  private readonly route: CognitiveLlmRoute

  constructor(ctx: Context, store: CognitiveStore, config: ColdEngineConfig, route: CognitiveLlmRoute) {
    this.ctx = ctx
    this.store = store
    this.config = config
    this.route = route
  }

  /**
   * Run one rebuild. `local` restricts sampling to the highest-error cluster;
   * `global` samples the whole store.
   * @param scope - the rebuild scope.
   * @param sessionId - optional session identity for the reconstruction call.
   * @param signal - optional cancellation for the reconstruction call.
   * @returns the backtested rebuild outcome; never rejects for domain reasons.
   */
  async runRebuild(
    scope: 'local' | 'global',
    sessionId?: GenerateOptions['sessionId'],
    signal?: AbortSignal,
  ): Promise<RebuildResult> {
    const all = this.store.experiencesSnapshot()
    if (all.length === 0) {
      return this.rejected(scope, [], 0, '无经验样本，跳过重构')
    }

    const sampled = this.sample(all, scope)
    if (sampled.length < this.config.evidenceMinCount) {
      return this.rejected(scope, sampled, 0, '采样样本不足，跳过重构')
    }

    // Newest `validationRatio` of the sampled set is the validation slice.
    // Pipeline-own meta experiences are learning signal, not held-out user
    // data: they always join the train slice so the reconstruct can cluster
    // retrieval-failure patterns, and they never skew the validation backtest
    // (their low-gain failure utilities would be over-predicted by success
    // clusters and counted against an honest proposal).
    const metaSamples = sampled.filter(exp => exp.meta === true)
    const nonMeta = sampled.filter(exp => exp.meta !== true)
    const validationSize = Math.max(1, Math.floor(nonMeta.length * this.config.validationRatio))
    const validation = nonMeta.slice(nonMeta.length - validationSize)
    const train = [...nonMeta.slice(0, nonMeta.length - validationSize), ...metaSamples]
      .sort((a, b) => a.timestamp - b.timestamp)

    // A rebuild is only meaningful when enough labeled validation samples
    // exist to judge it. With the continuous acceptance metric, "labeled"
    // means the experience carries a real material-gain label (a resolved
    // experience has one after the feedback-backfill). Fewer than
    // minValidationCount postpones the rebuild as `deferred` — a distinct,
    // diagnosable state rather than a merit rejection.
    const labeledValidation = validation
      .filter(exp => Number.isFinite(exp.sar.outcomeUtility.materialGain)).length
    if (labeledValidation < this.config.minValidationCount) {
      return this.deferred(scope, sampled, labeledValidation)
    }

    // ── utility-space clustering ──────────────────────────────────────────
    const groups = agglomerate(
      train.map(exp => exp.outcomeVector),
      this.config.clusterMergeCosine,
    ).filter(group => group.memberIndices.length >= this.config.evidenceMinCount)

    const groupsWithUtility = groups.map((group) => {
      const members = group.memberIndices
        .map(index => train[index])
        .filter((exp): exp is Experience => exp !== undefined)
      return {
        evidenceIds: members.map(exp => exp.expId),
        meanUtility: meanUtility(members),
      }
    })

    const summaryShort = this.composeGroupSummary(groups.length, groupsWithUtility)

    // ── LLM causal anchoring with backend evidence verification ───────────
    // The reconstruct route is stochastic: one draw may return zero clusters or
    // all-incoherent evidence while the next returns a usable set. Retry up to
    // `reconstructRetries` extra draws when a draw produces nothing verified, so
    // a single bad draw cannot silently block a rebuild that the data supports.
    const byId = new Map(all.map(exp => [exp.expId, exp]))
    let finalCandidates: CandidateCluster[] = []
    let rejectedClusters = 0
    let modelSummaryShort = ''
    const retries = this.config.reconstructRetries
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const reconstruct = await reconstructTaxonomy(
        this.ctx,
        this.route,
        train,
        groupsWithUtility,
        summaryShort,
        { sessionId, signal },
      )
      const candidates: CandidateCluster[] = reconstruct.newClusters.map((cluster) => {
        const evidence = cluster.supportingEvidenceIds
          .map(id => byId.get(id))
          .filter((exp): exp is Experience => exp !== undefined)
        const mean = meanUtility(evidence)
        return {
          name: cluster.clusterName,
          decisionRule: cluster.decisionRule,
          expectedUtilityRange: cluster.expectedUtilityRange,
          evidenceIds: cluster.supportingEvidenceIds,
          fallbackAction: cluster.fallbackAction,
          centroid: centroidOf(evidence.map(exp => exp.outcomeVector)),
          meanUtility: mean,
          polarity: meanUtilityScore(mean) > 0 ? 'success' : 'risk',
        }
      })
      const verified: CandidateCluster[] = []
      for (const candidate of candidates) {
        const check = verifyEvidence(candidate, byId, this.config.evidenceMinCount, this.config.evidenceMaxDistance)
        if (!check.ok) {
          rejectedClusters += 1
          this.ctx.logger.warn(`cognitive-pipeline: 簇 "${candidate.name}" 被证据校验驳回：${check.reason}`)
          continue
        }
        verified.push(candidate)
      }
      if (verified.length > 0 || attempt === retries) {
        finalCandidates = verified
        modelSummaryShort = reconstruct.taxonomySummaryShort
        if (reconstruct.newClusters.length === 0 && groupsWithUtility.length > 0) {
          // 附录C: LLM returned zero clusters — escalate sampling weight next round.
          this.ctx.logger.warn('cognitive-pipeline: 重构返回0个簇，将本轮样本标记为极端异常以提升下轮采样权重')
        }
        break
      }
      this.ctx.logger.warn(`cognitive-pipeline: 重构抽样产出不可用（${rejectedClusters} 个候选簇均未通过证据校验），第 ${attempt + 2} 次尝试`)
    }

    // Fallback when the model path produced nothing verified: the deterministic
    // groups must pass the SAME evidence hard constraint before they may be
    // written — a fallback path never bypasses verification.
    if (finalCandidates.length === 0 && groupsWithUtility.length > 0) {
      for (const candidate of this.fallbackCandidates(groupsWithUtility, byId)) {
        const check = verifyEvidence(candidate, byId, this.config.evidenceMinCount, this.config.evidenceMaxDistance)
        if (check.ok) {
          finalCandidates = [...finalCandidates, candidate]
        } else {
          rejectedClusters += 1
          this.ctx.logger.warn(`cognitive-pipeline: 回退簇 "${candidate.name}" 被证据校验驳回：${check.reason}`)
        }
      }
    }

    // ── sandbox backtest ──────────────────────────────────────────────────
    const oldViews = this.clusterViews(all, this.store.clustersSnapshot())
    const newViews = finalCandidates.map(candidate => ({
      centroid: candidate.centroid,
      meanUtility: candidate.meanUtility,
    }))
    const oldError = this.evaluateViews(all, train, validation, oldViews)
    const newError = this.evaluateViews(all, train, validation, newViews)
    // Two acceptance regimes. A rebuild with no stored clusters is a cold
    // start: its reference is the pure baseRate null model, and the first
    // verified cluster set is accepted when it is not measured WORSE than that
    // guess. The 15% margin is statistically meaningless on the tiny
    // validation slice a young store can produce, and the evidence hard
    // constraint already gates cluster quality; requiring 15% there would make
    // the first build unreachable (a validation slice of 2-3 samples caps any
    // measured improvement well below 15%). Iteration keeps the 15% bar
    // against the existing taxonomy so later rebuilds must meaningfully
    // improve; a first build with no old taxonomy compares against the
    // empty-view baseRate baseline, never the unreachable `newError <= 1e-9`.
    const firstBuild = this.store.clustersSnapshot().length === 0
    const requiredImprovement = firstBuild ? 0 : this.config.sandboxImprovement
    const referenceError = oldError ?? this.evaluateViews(all, train, validation, [])
    const deltaError = referenceError === null || referenceError <= 1e-9 || newError === null
      ? null
      : (newError - referenceError) / referenceError
    // Narrowing shape: `accepted` implies newError is a finite number and at
    // least one verified candidate cluster survived.
    const accepted = finalCandidates.length > 0 && newError !== null && (referenceError === null
      ? false
      : referenceError <= 1e-9
        ? false
        : deltaError !== null && deltaError <= -requiredImprovement)

    const taxonomyVersion = (this.store.taxonomySnapshot()?.version ?? 0) + (accepted ? 1 : 0)
    const reason = finalCandidates.length === 0
      ? `证据校验未通过：${rejectedClusters} 个候选簇均未满足证据约束（≥${this.config.evidenceMinCount}条真实经验、两两距离≤${this.config.evidenceMaxDistance}），无可写回簇`
      : accepted
        ? firstBuild
          ? `沙盒验证通过：新误差 ${newError.toFixed(3)} ≤ 基线 ${referenceError?.toFixed(3) ?? '—'}（冷启动，不差于纯基线预测）`
          : `沙盒验证通过：新误差 ${newError.toFixed(3)} ≤ 旧误差 ${referenceError?.toFixed(3) ?? '—'} × ${(1 - this.config.sandboxImprovement).toFixed(2)}`
        : deltaError === null
          ? referenceError !== null && referenceError <= 1e-9
            ? firstBuild
              ? '基线预测已接近完美（验证误差≈0），暂不写入簇'
              : '旧分类已接近完美（验证误差≈0），无需进一步重构'
            : '无旧分类基线，跳过回写'
          : firstBuild
            ? `冷启动验收未达标：新误差 ${newError?.toFixed(3) ?? '—'} vs 基线 ${referenceError?.toFixed(3) ?? '—'}（不得变差）`
            : `沙盒验证未达标：新误差 ${newError?.toFixed(3) ?? '—'} vs 旧误差 ${referenceError?.toFixed(3) ?? '—'}（需降低≥${Math.round(this.config.sandboxImprovement * 100)}%）`

    if (accepted) {
      this.writeBack(finalCandidates, taxonomyVersion, all, modelSummaryShort)
      return {
        scope,
        accepted: true,
        deferred: false,
        oldError,
        newError,
        deltaError,
        clusterCount: finalCandidates.length,
        rejectedClusters,
        sampleCount: sampled.length,
        reason,
        taxonomyVersion,
      }
    }

    // Rollback: promote validation misses into hard negatives for next round,
    // measured on the same continuous material-gain axis as acceptance.
    if (validation.length > 0) {
      const predicted = this.predictionsFor(train, newViews, validation)
      validation.forEach((exp, index) => {
        if (!Number.isFinite(exp.sar.outcomeUtility.materialGain)) return
        const actual = exp.sar.outcomeUtility.materialGain / 10
        const error = Math.abs((predicted[index] ?? 0.5) - actual)
        if (error >= this.config.predictionErrorThreshold) {
          this.store.updateExperience(exp.expId, { cumulativeError: exp.cumulativeError + error })
        }
      })
    }

    return {
      scope,
      accepted: false,
      deferred: false,
      oldError,
      newError,
      deltaError,
      clusterCount: 0,
      rejectedClusters,
      sampleCount: sampled.length,
      reason,
      taxonomyVersion,
    }
  }

  /** Short-circuit rejection result. */
  private rejected(scope: 'local' | 'global', sampled: readonly Experience[], rejectedClusters: number, reason: string): RebuildResult {
    return {
      scope,
      accepted: false,
      deferred: false,
      oldError: null,
      newError: null,
      deltaError: null,
      clusterCount: 0,
      rejectedClusters,
      sampleCount: sampled.length,
      reason,
      taxonomyVersion: this.store.taxonomySnapshot()?.version ?? 0,
    }
  }

  /** Short-circuit deferral result: insufficient labeled validation samples. */
  private deferred(
    scope: 'local' | 'global',
    sampled: readonly Experience[],
    labeledValidation: number,
  ): RebuildResult {
    return {
      scope,
      accepted: false,
      deferred: true,
      oldError: null,
      newError: null,
      deltaError: null,
      clusterCount: 0,
      rejectedClusters: 0,
      sampleCount: sampled.length,
      reason: `验证样本不足（带标签 ${labeledValidation} 条 < ${this.config.minValidationCount}），暂缓重建`,
      taxonomyVersion: this.store.taxonomySnapshot()?.version ?? 0,
    }
  }

  /** Decay-weighted, error-preferring sample selection (≤ maxSampleRatio).
   * A candidate joins when it is errorful (high prediction error or any
   * accumulated error) OR carries a clearly successful utility score — so the
   * cold loop learns from proven successes, not only from failures. Pipeline-own
   * meta experiences with a non-neutral utility also join (their error signal
   * has no user-feedback channel), so the cold loop can learn about the
   * pipeline's own failure modes (e.g. retrieval-routing ambiguity).
   */
  private sample(all: readonly Experience[], scope: 'local' | 'global'): Experience[] {
    const now = Date.now()
    const day = 24 * 60 * 60 * 1000
    const candidates = all.filter((exp) => {
      // Unverified simulated experiences never shape clusters: only verified
      // (or provisional, under observation) samples may join the cold loop.
      if (exp.simulated && exp.verification === 'unverified') return false
      const days = Math.max(0, (now - exp.timestamp) / day)
      const weight = Math.exp(-this.config.decayLambda * days)
      if (weight < this.config.minDecayWeight) return false
      const errorful = (exp.predictionError ?? 0) >= this.config.predictionErrorThreshold || exp.cumulativeError > 0
      const successful = utilityScore(exp.sar.outcomeUtility) >= this.config.successUtilityThreshold
      const metaSignal = exp.meta === true && outcomePolarity(exp.sar.outcomeUtility) !== 'neutral'
      return errorful || successful || metaSignal
    })

    if (scope === 'local') {
      const clusters = this.store.clustersSnapshot()
      let worst: Cluster | undefined
      for (const cluster of clusters) {
        if (worst === undefined || cluster.cumPredictionError > worst.cumPredictionError) worst = cluster
      }
      if (worst !== undefined) {
        const memberIds = new Set(worst.supportingEvidenceIds)
        const members = candidates.filter(exp => memberIds.has(exp.expId))
        if (members.length >= this.config.evidenceMinCount) {
          return this.cap(members, all.length).sort((a, b) => a.timestamp - b.timestamp)
        }
      }
    }

    return this.cap(candidates, all.length).sort((a, b) => a.timestamp - b.timestamp)
  }

  /**
   * Keep at most maxSampleRatio of the total population, error-first, with a
   * small-store floor so a rebuild stays possible before a store reaches
   * production scale (the ratio cap targets the 10万-record regime).
   */
  private cap(candidates: readonly Experience[], total: number): Experience[] {
    const budget = Math.min(total, Math.max(32, Math.floor(total * this.config.maxSampleRatio)))
    const sorted = [...candidates].sort((a, b) =>
      (b.cumulativeError + (b.predictionError ?? 0)) - (a.cumulativeError + (a.predictionError ?? 0)))
    const kept = sorted.slice(0, budget)
    // Meta experiences (pipeline-own learning signal) always join the sample:
    // they are few, deduplicated, and carry no user-error signal to rank by,
    // so the error-first sort would otherwise truncate them out of the budget.
    const meta = candidates.filter(exp => exp.meta === true && !kept.includes(exp))
    return meta.length === 0 ? kept : [...kept, ...meta]
  }

  /** Deterministic candidate clusters from the agglomerative groups. */
  private fallbackCandidates(
    groups: readonly { evidenceIds: readonly string[]; meanUtility: OutcomeUtility }[],
    byId: ReadonlyMap<string, Experience>,
  ): CandidateCluster[] {
    return groups.map((group, index) => {
      const evidence = group.evidenceIds.map(id => byId.get(id)).filter((exp): exp is Experience => exp !== undefined)
      const mean = group.meanUtility
      return {
        name: `策略簇#${index + 1}（收益${mean.materialGain.toFixed(1)}/情绪${mean.emotionalValence.toFixed(1)}/代价${mean.energyCost.toFixed(1)}）`,
        decisionRule: `if 情境特征与簇${index + 1}相似 then 沿用簇内已验证行动`,
        expectedUtilityRange: {
          low: Math.max(0, mean.materialGain - 2),
          high: Math.min(10, mean.materialGain + 2),
        },
        evidenceIds: group.evidenceIds,
        fallbackAction: '降低行动强度并观察反馈',
        centroid: centroidOf(evidence.map(exp => exp.outcomeVector)),
        meanUtility: mean,
        polarity: meanUtilityScore(mean) > 0 ? 'success' : 'risk',
      }
    })
  }

  /** ≤30-char summary of the rebuild's logical change from group statistics. */
  private composeGroupSummary(
    groupCount: number,
    groups: readonly { evidenceIds: readonly string[]; meanUtility: OutcomeUtility }[],
  ): string {
    const tones = groups.map((group) => {
      const score = meanUtilityScore(group.meanUtility)
      if (score > 0) return '正效'
      if (score < 0) return '负效'
      return '中性'
    })
    const prefix = tones.length === 0 ? '无' : tones.slice(0, 3).join('/')
    return `重组为${groupCount}簇（${prefix}…）`
  }

  /** Build normalized views for the stored cluster table. */
  private clusterViews(
    all: readonly Experience[],
    clusters: readonly Cluster[],
  ): TaxonomyView[] {
    const byId = new Map(all.map(exp => [exp.expId, exp]))
    const views: TaxonomyView[] = []
    for (const cluster of clusters) {
      const evidence = cluster.supportingEvidenceIds.map(id => byId.get(id)).filter((exp): exp is Experience => exp !== undefined)
      if (evidence.length === 0) continue
      views.push({
        centroid: centroidOf(evidence.map(exp => exp.outcomeVector)),
        meanUtility: meanUtility(evidence),
      })
    }
    return views
  }

  /** Predict the continuous material-gain label (normalized to [0,1]) for each
   * validation experience under a taxonomy. The prediction is the mean
   * material gain of the nearest cluster; unmatched experiences fall back to
   * the training base-rate gain. This aligns the acceptance metric with the
   * pipeline's first-principle error `|calibrated − observed|` — it measures
   * whether the taxonomy predicts utility, not just which polarity bucket an
   * experience lands in.
   */
  private predictionsFor(
    train: readonly Experience[],
    taxonomy: readonly TaxonomyView[],
    validation: readonly Experience[],
  ): number[] {
    const baseRate = train.length === 0
      ? 0.5
      : train.reduce((sum, exp) => sum + exp.sar.outcomeUtility.materialGain, 0) / train.length / 10
    return validation.map((exp) => {
      let best = -1
      let bestScore = this.config.clusterMatchCosine
      for (const view of taxonomy) {
        const score = cosine(exp.outcomeVector, view.centroid)
        if (score >= bestScore) {
          bestScore = score
          best = view.meanUtility.materialGain / 10
        }
      }
      return best < 0 ? baseRate : best
    })
  }

  /** Mean absolute error of a taxonomy over the validation slice, on the
   * continuous material-gain axis. Every experience with a recorded gain
   * participates (resolved experiences carry a real label after the
   * feedback-backfill), so "predicted wrong but quality known" samples are no
   * longer excluded from the acceptance judgment.
   */
  private evaluateViews(
    all: readonly Experience[],
    train: readonly Experience[],
    validation: readonly Experience[],
    taxonomy: readonly TaxonomyView[],
  ): number | null {
    void all
    const labeled = validation.filter(exp => Number.isFinite(exp.sar.outcomeUtility.materialGain))
    if (labeled.length === 0) return null
    const predicted = this.predictionsFor(train, taxonomy, validation)
    let error = 0
    for (let index = 0; index < validation.length; index += 1) {
      const exp = validation[index] as Experience
      if (!Number.isFinite(exp.sar.outcomeUtility.materialGain)) continue
      const actual = exp.sar.outcomeUtility.materialGain / 10
      error += Math.abs((predicted[index] ?? 0.5) - actual)
    }
    return error / labeled.length
  }

  /** Apply the accepted taxonomy: new clusters, assignments, summary, rules. */
  private writeBack(
    candidates: readonly CandidateCluster[],
    taxonomyVersion: number,
    all: readonly Experience[],
    modelSummaryShort: string,
  ): void {
    const now = Date.now()
    const assignments = new Map<string, { clusterId: number; strategyLabel: string }>()
    const clusters: Cluster[] = []
    const byId = new Map(all.map(exp => [exp.expId, exp]))

    for (const candidate of candidates) {
      const clusterId = this.store.nextClusterId()
      const members = all.filter(exp => cosine(exp.outcomeVector, candidate.centroid) >= this.config.clusterMatchCosine)
      if (members.length === 0) continue
      let cumError = 0
      for (const member of members) {
        cumError += member.cumulativeError + (member.predictionError ?? 0)
        assignments.set(member.expId, { clusterId, strategyLabel: candidate.name })
      }
      // The situation centroid comes from the EVIDENCE experiences (the model's
      // chosen core of the pattern), not from every outcome-similar member: with
      // outcome-identical premise-differentiated clusters (e.g. novice-teaching
      // vs expert-direct on the same action), outcome-based membership would
      // claim both patterns and dilute the centroid into a mixture, killing
      // situation-strategy differentiation at retrieval.
      const evidence = candidate.evidenceIds
        .map(id => byId.get(id))
        .filter((exp): exp is Experience => exp !== undefined)
      clusters.push({
        clusterId,
        name: candidate.name,
        decisionRule: candidate.decisionRule,
        expectedUtilityRange: { ...candidate.expectedUtilityRange },
        supportingEvidenceIds: [...candidate.evidenceIds],
        fallbackAction: candidate.fallbackAction,
        createdAt: now,
        origin: 'cold-loop',
        sampleCount: members.length,
        cumPredictionError: cumError,
        polarity: candidate.polarity,
        situationCentroid: centroidOf(evidence.map(exp => actionVector(exp.sar.situation, []))),
      })
    }

    // Graduated scratchpad strategies act as label seeds: attach their trial
    // action to the nearest verified cluster's rule when it matches.
    for (const strategy of this.store.tempStrategiesSnapshot()) {
      if (strategy.status !== 'graduated') continue
      const index = this.nearestClusterIndex(strategy, clusters, byId)
      if (index < 0) continue
      const cluster = clusters[index] as Cluster
      clusters[index] = {
        ...cluster,
        decisionRule: `if 情境与「${strategy.trialAction}」相似 then 沿用该试行策略`,
      }
    }

    const rules: TaxonomyRule[] = [...clusters]
      .sort((a, b) => b.sampleCount - a.sampleCount)
      .slice(0, 5)
      .map(cluster => ({
        condition: cluster.name,
        action: cluster.decisionRule,
        utilityRange: { ...cluster.expectedUtilityRange },
        polarity: cluster.polarity,
      }))

    const taxonomy: TaxonomyState = {
      version: taxonomyVersion,
      // Prefer the model's one-line summary; fall back to a versioned label.
      summaryShort: modelSummaryShort.trim().length > 0
        ? modelSummaryShort.slice(0, 60)
        : this.composeVersionSummary(taxonomyVersion, clusters),
      rules,
      updatedAt: now,
    }
    this.store.applyTaxonomy(clusters, taxonomy, assignments)
  }

  /** Index of the graduated strategy's nearest verified cluster, or -1. */
  private nearestClusterIndex(
    strategy: TempStrategy,
    clusters: readonly Cluster[],
    byId: ReadonlyMap<string, Experience>,
  ): number {
    if (strategy.trialAction.length === 0) return -1
    const source = strategy.sourceExpId === null ? null : byId.get(strategy.sourceExpId) ?? null
    const seedUtility: OutcomeUtility = source === null
      ? { materialGain: 6, emotionalValence: 6, energyCost: 5 }
      : source.sar.outcomeUtility
    const strategyVector = outcomeVector(seedUtility, strategy.trialAction)
    let bestIndex = -1
    let bestScore = this.config.clusterMatchCosine
    for (let index = 0; index < clusters.length; index += 1) {
      const cluster = clusters[index] as Cluster
      const evidence = cluster.supportingEvidenceIds.map(id => byId.get(id)).filter((exp): exp is Experience => exp !== undefined)
      if (evidence.length === 0) continue
      const centroid = centroidOf(evidence.map(exp => exp.outcomeVector))
      const score = cosine(strategyVector, centroid)
      if (score >= bestScore) {
        bestScore = score
        bestIndex = index
      }
    }
    return bestIndex
  }

  /** Compose the one-sentence taxonomy summary for the prompt prefix. */
  private composeVersionSummary(version: number, clusters: readonly Cluster[]): string {
    const names = clusters.slice(0, 3).map(cluster => cluster.name)
    const core = names.length === 0 ? '无有效策略簇' : names.join('；')
    return `v${version}:${core.slice(0, 30)}`
  }
}
