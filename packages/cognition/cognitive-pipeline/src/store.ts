/**
 * File-backed store of the cognitive pipeline. In-memory maps serve the hot
 * path; JSONL files under the configured root persist each table. Mutations
 * are synchronous in memory and enqueue an atomic (write-temp + rename)
 * persistence pass; `flush()` awaits all pending writes.
 * @module @deepseek-ai/dsh-cognitive-pipeline/store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  CalibrationBucket,
  Cluster,
  Experience,
  Prediction,
  TaxonomyState,
  TempStrategy,
} from './types.ts'

/** How many calibration deciles the lifetime stats keep. */
export const CALIBRATION_BUCKETS = 10

/**
 * Index a probability into its decile bucket.
 * @param probability - the probability in [0, 1].
 * @returns the decile index 0–9.
 */
export function bucketIndex(probability: number): number {
  return Math.min(CALIBRATION_BUCKETS - 1, Math.max(0, Math.floor(probability * CALIBRATION_BUCKETS)))
}
/** One JSONL line reader that tolerates blank/trailing lines. */
function parseLines(source: string): unknown[] {
  const records: unknown[] = []
  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      records.push(JSON.parse(trimmed))
    } catch {
      // A corrupt line is skipped rather than failing the whole store boot.
      continue
    }
  }
  return records
}

/** Awaitable serial write queue so flushes never interleave. */
class WriteQueue {
  private tail: Promise<void> = Promise.resolve()

  /** Chain one write behind the previous; returns the chained promise. */
  push(write: () => Promise<void>): Promise<void> {
    const next = this.tail.then(write, write)
    this.tail = next.catch(() => {})
    return next
  }

  /** Settle only after every enqueued write finished. */
  async drain(): Promise<void> {
    await this.tail
  }
}

/** Create a fresh decile bucket table. */
function emptyBuckets(): CalibrationBucket[] {
  return Array.from({ length: CALIBRATION_BUCKETS }, (_, index) => ({
    bucketIndex: index,
    totalCount: 0,
    hitCount: 0,
    empiricalAccuracy: null,
  }))
}

/** The complete persisted state of one pipeline store. */
export class CognitiveStore {
  private readonly root: string
  private readonly queue = new WriteQueue()
  private experiences = new Map<string, Experience>()
  private predictions = new Map<string, Prediction>()
  private tempStrategies = new Map<string, TempStrategy>()
  private clusterList: Cluster[] = []
  private calibration = emptyBuckets()
  private taxonomyState: TaxonomyState | null = null
  private nextExpSeq = 1
  private nextPredictionSeq = 1
  private nextClusterSeq = 1

  /**
   * @param root - directory that will hold the JSONL/JSON state files.
   */
  constructor(root: string) {
    this.root = root
  }

  private file(name: string): string {
    return join(this.root, name)
  }

  /** Create the root and load every table. Missing files start empty. */
  async load(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    const [experiences, predictions, tempStrategies, clusters, calibration, taxonomy] = await Promise.all([
      readFile(this.file('experiences.jsonl'), 'utf8').catch(() => ''),
      readFile(this.file('predictions.jsonl'), 'utf8').catch(() => ''),
      readFile(this.file('temp_strategies.jsonl'), 'utf8').catch(() => ''),
      readFile(this.file('clusters.json'), 'utf8').catch(() => ''),
      readFile(this.file('calibration.json'), 'utf8').catch(() => ''),
      readFile(this.file('taxonomy.json'), 'utf8').catch(() => ''),
    ])
    for (const record of parseLines(experiences)) {
      if (typeof record !== 'object' || record === null) continue
      const exp = record as Experience
      if (typeof exp.expId !== 'string') continue
      this.experiences.set(exp.expId, exp)
      this.nextExpSeq = Math.max(this.nextExpSeq, expSeqOf(exp.expId) + 1)
    }
    for (const record of parseLines(predictions)) {
      if (typeof record !== 'object' || record === null) continue
      const prediction = record as Prediction
      if (typeof prediction.predictionId !== 'string') continue
      this.predictions.set(prediction.predictionId, prediction)
      this.nextPredictionSeq = Math.max(this.nextPredictionSeq, predictionSeqOf(prediction.predictionId) + 1)
    }
    for (const record of parseLines(tempStrategies)) {
      if (typeof record !== 'object' || record === null) continue
      const strategy = record as TempStrategy
      if (typeof strategy.signatureHash !== 'string') continue
      this.tempStrategies.set(strategy.signatureHash, strategy)
    }
    if (clusters !== '') {
      const parsed = JSON.parse(clusters) as unknown
      if (Array.isArray(parsed)) {
        this.clusterList = parsed.filter((cluster): cluster is Cluster => {
          if (typeof cluster !== 'object' || cluster === null) return false
          return typeof (cluster as Cluster).clusterId === 'number'
        })
        for (const cluster of this.clusterList) {
          this.nextClusterSeq = Math.max(this.nextClusterSeq, cluster.clusterId + 1)
        }
      }
    }
    const parsedCalibration = calibration === '' ? null : JSON.parse(calibration) as CalibrationBucket[] | null
    if (Array.isArray(parsedCalibration) && parsedCalibration.length === CALIBRATION_BUCKETS) {
      this.calibration = parsedCalibration
    }
    if (taxonomy !== '') {
      const parsed = JSON.parse(taxonomy) as TaxonomyState
      if (typeof parsed.version === 'number') this.taxonomyState = parsed
    }
  }

  /** Await every pending persistence write. */
  async flush(): Promise<void> {
    await this.queue.drain()
  }

  private enqueue(name: string, payload: unknown): void {
    const file = this.file(name)
    const data = typeof payload === 'string' ? payload : `${JSON.stringify(payload)}\n`
    void this.queue.push(async () => {
      const tmp = `${file}.tmp`
      await writeFile(tmp, data, 'utf8')
      await rename(tmp, file)
    })
  }

  private enqueueLines(name: string, records: readonly unknown[]): void {
    const lines = records.map(record => JSON.stringify(record)).join('\n') + (records.length > 0 ? '\n' : '')
    this.enqueue(name, lines)
  }

  // ── experiences ──────────────────────────────────────────────────────────

  /**
   * Store one experience and enqueue its persistence.
   * @param exp - the experience to add.
   */
  addExperience(exp: Experience): void {
    this.experiences.set(exp.expId, exp)
    this.enqueueLines('experiences.jsonl', [...this.experiences.values()])
  }

  /**
   * Read one experience by id.
   * @param expId - the experience id.
   * @returns the experience, or undefined.
   */
  getExperience(expId: string): Experience | undefined {
    return this.experiences.get(expId)
  }

  /** Snapshot of every stored experience.
   * @returns experiences in insertion order.
   */
  experiencesSnapshot(): readonly Experience[] {
    return [...this.experiences.values()]
  }

  /**
   * Apply a partial patch to one experience and enqueue its persistence.
   * @param expId - the experience id.
   * @param patch - the fields to replace.
   * @returns the updated experience.
   */
  updateExperience(expId: string, patch: Partial<Experience>): Experience {
    const current = this.experiences.get(expId)
    if (current === undefined) {
      throw new Error(`cognitive-pipeline: experience "${expId}" not found`)
    }
    const next: Experience = { ...current, ...patch }
    this.experiences.set(expId, next)
    this.enqueueLines('experiences.jsonl', [...this.experiences.values()])
    return next
  }

  // ── predictions ──────────────────────────────────────────────────────────

  /** Store one prediction and enqueue its persistence.
   * @param prediction - the prediction to add.
   */
  addPrediction(prediction: Prediction): void {
    this.predictions.set(prediction.predictionId, prediction)
    this.enqueueLines('predictions.jsonl', [...this.predictions.values()])
  }

  /** Read one prediction by id.
   * @param predictionId - the prediction id.
   * @returns the prediction, or undefined.
   */
  getPrediction(predictionId: string): Prediction | undefined {
    return this.predictions.get(predictionId)
  }

  /** Snapshot of every stored prediction.
   * @returns predictions in insertion order.
   */
  predictionsSnapshot(): readonly Prediction[] {
    return [...this.predictions.values()]
  }

  /**
   * Resolve one prediction with its actual outcome, propagating the absolute
   * prediction error to the bound experience's cumulative error.
   * @param predictionId - the prediction to resolve.
   * @param actualOutcome - the observed outcome text.
   * @param predictionError - absolute error in [0, 1].
   * @returns the resolved prediction.
   */
  resolvePrediction(
    predictionId: string,
    actualOutcome: string,
    predictionError: number,
  ): Prediction {
    const current = this.predictions.get(predictionId)
    if (current === undefined) {
      throw new Error(`cognitive-pipeline: prediction "${predictionId}" not found`)
    }
    const now = Date.now()
    const resolved: Prediction = {
      ...current,
      actualOutcome,
      predictionError,
      resolvedAt: now,
    }
    this.predictions.set(predictionId, resolved)
    this.enqueueLines('predictions.jsonl', [...this.predictions.values()])
    if (current.expId !== null) {
      const exp = this.experiences.get(current.expId)
      if (exp !== undefined) {
        const next: Experience = {
          ...exp,
          predictionError,
          cumulativeError: exp.cumulativeError + predictionError,
        }
        this.experiences.set(exp.expId, next)
        this.enqueueLines('experiences.jsonl', [...this.experiences.values()])
      }
    }
    return resolved
  }

  // ── temp strategies ──────────────────────────────────────────────────────

  /** Read one scratchpad strategy by signature hash.
   * @param signatureHash - the strategy key.
   * @returns the strategy, or undefined.
   */
  getTempStrategy(signatureHash: string): TempStrategy | undefined {
    return this.tempStrategies.get(signatureHash)
  }

  /** Store one scratchpad strategy and enqueue its persistence.
   * @param strategy - the strategy to add.
   */
  addTempStrategy(strategy: TempStrategy): void {
    this.tempStrategies.set(strategy.signatureHash, strategy)
    this.enqueueLines('temp_strategies.jsonl', [...this.tempStrategies.values()])
  }

  /** Apply a partial patch to one scratchpad strategy.
   * @param signatureHash - the strategy key.
   * @param patch - the fields to replace.
   * @returns the updated strategy.
   */
  updateTempStrategy(signatureHash: string, patch: Partial<TempStrategy>): TempStrategy {
    const current = this.tempStrategies.get(signatureHash)
    if (current === undefined) {
      throw new Error(`cognitive-pipeline: temp strategy "${signatureHash}" not found`)
    }
    const next: TempStrategy = { ...current, ...patch }
    this.tempStrategies.set(signatureHash, next)
    this.enqueueLines('temp_strategies.jsonl', [...this.tempStrategies.values()])
    return next
  }

  /** Snapshot of every scratchpad strategy.
   * @returns strategies in insertion order.
   */
  tempStrategiesSnapshot(): readonly TempStrategy[] {
    return [...this.tempStrategies.values()]
  }

  /**
   * Expire active strategies past their TTL.
   * @param now - the reference timestamp; defaults to the current time.
   * @returns the hashes that were expired.
   */
  expireTempStrategies(now: number = Date.now()): string[] {
    const expired: string[] = []
    for (const [hash, strategy] of this.tempStrategies) {
      if (strategy.status === 'active' && strategy.expiresAt < now) {
        this.tempStrategies.set(hash, { ...strategy, status: 'expired' })
        expired.push(hash)
      }
    }
    if (expired.length > 0) {
      this.enqueueLines('temp_strategies.jsonl', [...this.tempStrategies.values()])
    }
    return expired
  }

  // ── calibration ──────────────────────────────────────────────────────────

  /** Record one resolved prediction in its confidence decile.
   * @param probability - the calibrated probability.
   * @param hit - whether the outcome was positive.
   */
  recordCalibration(probability: number, hit: boolean): void {
    const index = bucketIndex(probability)
    const bucket = this.calibration[index]
    if (bucket === undefined) {
      throw new Error('cognitive-pipeline: calibration bucket out of range')
    }
    const totalCount = bucket.totalCount + 1
    const hitCount = bucket.hitCount + (hit ? 1 : 0)
    this.calibration[index] = {
      bucketIndex: index,
      totalCount,
      hitCount,
      empiricalAccuracy: hitCount / totalCount,
    }
    this.enqueue('calibration.json', this.calibration)
  }

  /** Snapshot of every calibration bucket.
   * @returns a detached decile table.
   */
  calibrationBucketsSnapshot(): readonly CalibrationBucket[] {
    return this.calibration.map(bucket => ({ ...bucket }))
  }

  /**
   * Lifetime empirical accuracy for one probability's decile bucket.
   * @param probability - the calibrated probability.
   * @returns the bucket accuracy, or null when the bucket has no count.
   */
  empiricalAccuracyFor(probability: number): number | null {
    const bucket = this.calibration[bucketIndex(probability)]
    return bucket === undefined ? null : bucket.empiricalAccuracy
  }

  // ── clusters + taxonomy ──────────────────────────────────────────────────

  /** Snapshot of the cluster table.
   * @returns clusters with detached fields.
   */
  clustersSnapshot(): readonly Cluster[] {
    return this.clusterList.map(cluster => ({ ...cluster }))
  }

  /** Snapshot of the current taxonomy.
   * @returns the taxonomy, or null before the first rebuild.
   */
  taxonomySnapshot(): TaxonomyState | null {
    return this.taxonomyState === null ? null : {
      ...this.taxonomyState,
      rules: [...this.taxonomyState.rules],
    }
  }

  /** Allocate the next cluster id.
   * @returns a fresh monotonically increasing id.
   */
  nextClusterId(): number {
    const id = this.nextClusterSeq
    this.nextClusterSeq += 1
    return id
  }

  /**
   * Atomically replace the cluster table and taxonomy, and reassign member
   * experiences to their new clusters. One enqueued flush per table keeps the
   * files consistent with each other.
   * @param clusters - the new cluster table.
   * @param taxonomy - the new taxonomy snapshot.
   * @param assignments - per-experience cluster membership to write back.
   */
  applyTaxonomy(
    clusters: readonly Cluster[],
    taxonomy: TaxonomyState,
    assignments: ReadonlyMap<string, { clusterId: number; strategyLabel: string }>,
  ): void {
    this.clusterList = clusters.map(cluster => ({ ...cluster }))
    this.taxonomyState = { ...taxonomy, rules: [...taxonomy.rules] }
    this.enqueue('clusters.json', this.clusterList)
    this.enqueue('taxonomy.json', this.taxonomyState)
    for (const [expId, assignment] of assignments) {
      const exp = this.experiences.get(expId)
      if (exp !== undefined) {
        this.experiences.set(expId, {
          ...exp,
          clusterId: assignment.clusterId,
          strategyLabel: assignment.strategyLabel,
        })
      }
    }
    this.enqueueLines('experiences.jsonl', [...this.experiences.values()])
  }

  /** Simple in-memory + disk counts for inspection.
   * @returns experience, prediction, and resolved counts.
   */
  stats(): { experienceCount: number; predictionCount: number; resolvedPredictionCount: number } {
    let resolved = 0
    for (const prediction of this.predictions.values()) {
      if (prediction.resolvedAt !== null) resolved += 1
    }
    return {
      experienceCount: this.experiences.size,
      predictionCount: this.predictions.size,
      resolvedPredictionCount: resolved,
    }
  }

  // ── id generation ────────────────────────────────────────────────────────

  /** Allocate the next experience id.
   * @returns `exp_<n>`.
   */
  nextExpId(): string {
    const id = `exp_${this.nextExpSeq}`
    this.nextExpSeq += 1
    return id
  }

  /** Allocate the next prediction id.
   * @returns `pred_<n>`.
   */
  nextPredictionId(): string {
    const id = `pred_${this.nextPredictionSeq}`
    this.nextPredictionSeq += 1
    return id
  }
}

/** Extract the numeric sequence from an `exp_<n>` id. */
function expSeqOf(expId: string): number {
  const match = /^exp_(\d+)$/.exec(expId)
  return match === null ? 0 : Number(match[1])
}

/** Extract the numeric sequence from a `pred_<n>` id. */
function predictionSeqOf(predictionId: string): number {
  const match = /^pred_(\d+)$/.exec(predictionId)
  return match === null ? 0 : Number(match[1])
}
