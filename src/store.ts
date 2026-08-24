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
  AcceptanceCheck,
  CalibrationBucket,
  ChannelWeights,
  ChainExperience,
  ChainPattern,
  ClaimAudit,
  Cluster,
  Experience,
  ExploreEntry,
  ExplorationState,
  ExplorationTask,
  ExplorationTaskStatus,
  InjectionRecord,
  LoopExecutionReceipt,
  Prediction,
  SolidifiedStrategy,
  TaxonomyState,
  TempStrategy,
  TriggerJump,
  VariantCandidate,
} from './types.ts'
import { ACTION_VECTOR_DIM, DEFAULT_DISEQUILIBRIUM_MIN_SAMPLES, DEFAULT_DISEQUILIBRIUM_Z, actionVector, disequilibriumOf } from './vectorizer.ts'

/** How many calibration deciles the lifetime stats keep. */
export const CALIBRATION_BUCKETS = 10

/** Local date key of the exploration budget window (`YYYY-MM-DD`).
 * @returns the local date key.
 */
export function todayKey(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

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

/** Clamp a persisted channel weight into the learnable band [0.2, 3]. */
function clampWeight(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 1
  return Math.min(3, Math.max(0.2, n))
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
  private channelWeights: ChannelWeights = { semantic: 1, situational: 1, symptom: 1, outcome: 1 }
  private explorationState: ExplorationState = { date: todayKey(), used: 0, entries: [] }
  private explorationTasks = new Map<string, ExplorationTask>()
  private loopExecutions = new Map<string, LoopExecutionReceipt>()
  private acceptance = new Map<string, AcceptanceCheck>()
  private claimAudits = new Map<string, ClaimAudit>()
  private triggerJumps = new Map<string, TriggerJump>()
  private injections = new Map<string, InjectionRecord>()
  private chains = new Map<string, ChainExperience>()
  private chainPatterns = new Map<string, ChainPattern>()
  private solidifiedStrategies = new Map<string, SolidifiedStrategy>()
  private variants = new Map<string, VariantCandidate>()
  private taxonomyState: TaxonomyState | null = null
  private nextExpSeq = 1
  private nextPredictionSeq = 1
  private nextClusterSeq = 1
  private nextTaskSeq = 1
  private nextAcceptanceSeq = 1
  private nextAuditSeq = 1
  private nextStrategySeq = 1
  private nextInjectionSeq = 1
  private nextVariantSeq = 1

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
    const [
      experiences, predictions, tempStrategies, clusters, calibration,
      channelWeights, exploration, tasks, loopExecutions, acceptance,
      claimAudits, triggerJumps, injections, chains, chainPatterns, taxonomy,
      solidifiedStrategies, variants,
    ] = await Promise.all([
      readFile(this.file('experiences.jsonl'), 'utf8').catch(() => ''),
      readFile(this.file('predictions.jsonl'), 'utf8').catch(() => ''),
      readFile(this.file('temp_strategies.jsonl'), 'utf8').catch(() => ''),
      readFile(this.file('clusters.json'), 'utf8').catch(() => ''),
      readFile(this.file('calibration.json'), 'utf8').catch(() => ''),
      readFile(this.file('channel_weights.json'), 'utf8').catch(() => ''),
      readFile(this.file('exploration.json'), 'utf8').catch(() => ''),
      readFile(this.file('exploration_tasks.json'), 'utf8').catch(() => ''),
      readFile(this.file('loop_executions.jsonl'), 'utf8').catch(() => ''),
      readFile(this.file('acceptance.json'), 'utf8').catch(() => ''),
      readFile(this.file('claim_audits.jsonl'), 'utf8').catch(() => ''),
      readFile(this.file('trigger_jumps.json'), 'utf8').catch(() => ''),
      readFile(this.file('injections.jsonl'), 'utf8').catch(() => ''),
      readFile(this.file('chains.json'), 'utf8').catch(() => ''),
      readFile(this.file('chain_patterns.json'), 'utf8').catch(() => ''),
      readFile(this.file('taxonomy.json'), 'utf8').catch(() => ''),
      readFile(this.file('solidified_strategies.json'), 'utf8').catch(() => ''),
      readFile(this.file('variants.json'), 'utf8').catch(() => ''),
    ])
    for (const record of parseLines(experiences)) {
      if (typeof record !== 'object' || record === null) continue
      const exp = record as Experience
      if (typeof exp.expId !== 'string') continue
      // Chain-tag fields are optional on legacy rows; normalize missing values
      // to explicit absences so chain assembly reads them cleanly.
      this.experiences.set(exp.expId, {
        ...exp,
        ...typeof exp.chainId === 'string' ? { chainId: exp.chainId } : {},
        ...typeof exp.parentNodeId === 'string' ? { parentNodeId: exp.parentNodeId } : {},
        ...Number.isInteger(exp.sequence) ? { sequence: exp.sequence } : {},
        ...exp.selfReflexive === true ? { selfReflexive: true } : {},
      })
      this.nextExpSeq = Math.max(this.nextExpSeq, expSeqOf(exp.expId) + 1)
    }
    for (const record of parseLines(predictions)) {
      if (typeof record !== 'object' || record === null) continue
      const prediction = record as Prediction
      if (typeof prediction.predictionId !== 'string') continue
      // Older records predate the fusion field; normalize to null.
      this.predictions.set(prediction.predictionId, { ...prediction, fusion: prediction.fusion ?? null })
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
        this.clusterList = parsed
          .filter((cluster): cluster is Record<string, unknown> => {
            if (typeof cluster !== 'object' || cluster === null) return false
            return typeof (cluster as Record<string, unknown>).clusterId === 'number'
          })
          .map(cluster => this.normalizeCluster(cluster))
        for (const cluster of this.clusterList) {
          this.nextClusterSeq = Math.max(this.nextClusterSeq, cluster.clusterId + 1)
        }
      }
    }
    const parsedCalibration = calibration === '' ? null : JSON.parse(calibration) as CalibrationBucket[] | null
    if (Array.isArray(parsedCalibration) && parsedCalibration.length === CALIBRATION_BUCKETS) {
      this.calibration = parsedCalibration
    }
    if (channelWeights !== '') {
      const parsed = JSON.parse(channelWeights) as Record<string, unknown> | null
      if (typeof parsed === 'object' && parsed !== null) {
        this.channelWeights = {
          semantic: clampWeight(parsed.semantic),
          situational: clampWeight(parsed.situational),
          symptom: clampWeight(parsed.symptom),
          outcome: clampWeight(parsed.outcome),
        }
      }
    }
    if (exploration !== '') {
      const parsed = JSON.parse(exploration) as { date?: unknown; used?: unknown; entries?: unknown } | null
      if (typeof parsed === 'object' && parsed !== null && typeof parsed.date === 'string') {
        const entries = Array.isArray(parsed.entries) ? parsed.entries : []
        this.explorationState = {
          date: parsed.date,
          used: typeof parsed.used === 'number' && Number.isFinite(parsed.used) ? parsed.used : 0,
          // Older files predate the validation fields; normalize missing values
          // to the explicit nulls so EWMA folds start clean instead of on NaN.
          entries: entries.filter((entry): entry is ExploreEntry => {
            if (typeof entry !== 'object' || entry === null) return false
            const e = entry as Record<string, unknown>
            return typeof e.ts === 'number' && typeof e.action === 'string' && typeof e.scratchpadHash === 'string'
          }).map((entry) => {
            // The type guard narrowed the entry, but legacy files genuinely
            // omit the validation fields — read them through the raw record
            // and keep only values that satisfy the wire shape.
            const raw = entry as unknown as Record<string, unknown>
            const validatedError = typeof raw.validatedError === 'number' ? raw.validatedError : null
            const validated = raw.validated === true || raw.validated === false ? raw.validated : null
            return { ...entry, validatedError, validated }
          }),
        }
      }
    }
    if (tasks !== '') {
      const parsed = JSON.parse(tasks) as unknown
      if (Array.isArray(parsed)) {
        for (const record of parsed) {
          if (typeof record !== 'object' || record === null) continue
          const task = record as ExplorationTask
          if (typeof task.taskId !== 'string' || typeof task.goal !== 'string') continue
          this.explorationTasks.set(task.taskId, task)
          const seq = Number(task.taskId.replace('task_', ''))
          if (Number.isFinite(seq)) this.nextTaskSeq = Math.max(this.nextTaskSeq, seq + 1)
        }
      }
    }
    for (const record of parseLines(loopExecutions)) {
      if (typeof record !== 'object' || record === null) continue
      const receipt = record as LoopExecutionReceipt
      if (typeof receipt.receiptId !== 'string' || typeof receipt.predictionId !== 'string') continue
      this.loopExecutions.set(receipt.receiptId, receipt)
    }
    if (acceptance !== '') {
      const parsed = JSON.parse(acceptance) as unknown
      if (Array.isArray(parsed)) {
        for (const record of parsed) {
          if (typeof record !== 'object' || record === null) continue
          const check = record as AcceptanceCheck
          if (typeof check.checkId !== 'string' || typeof check.criterion !== 'string') continue
          // Rows predating the machine-verified ledger carry logVerifiedCount
          // (and older ones nothing); normalize to the renamed counter so the
          // fold starts clean instead of on NaN.
          const rawCheck = record as unknown as { logVerifiedCount?: unknown }
          const legacyCount = typeof rawCheck.logVerifiedCount === 'number'
            && Number.isInteger(rawCheck.logVerifiedCount)
            ? rawCheck.logVerifiedCount
            : 0
          this.acceptance.set(check.checkId, {
            ...check,
            machineVerifiedCount: Number.isInteger(check.machineVerifiedCount) && check.machineVerifiedCount >= 0
              ? check.machineVerifiedCount
              : legacyCount,
          })
          const seq = Number(check.checkId.replace('check_', ''))
          if (Number.isFinite(seq)) this.nextAcceptanceSeq = Math.max(this.nextAcceptanceSeq, seq + 1)
        }
      }
    }
    for (const record of parseLines(claimAudits)) {
      if (typeof record !== 'object' || record === null) continue
      const audit = record as ClaimAudit
      if (typeof audit.auditId !== 'string' || typeof audit.claim !== 'string') continue
      // Rows predating the unified anchor carry logAnchor/logVerified; read the
      // raw row and map the legacy log anchor onto the unified `anchor` shape
      // so a missing anchorVerified normalizes to false, not undefined.
      const rawAudit = record as unknown as {
        anchorVerified?: unknown
        logVerified?: unknown
        logAnchor?: { toolName?: unknown; callId?: unknown; expectedSucceeded?: unknown; matched?: unknown } | null
      }
      const legacyLog = rawAudit.logAnchor
      const anchor = audit.anchor ?? (typeof legacyLog === 'object' && legacyLog !== null
        ? {
          kind: 'log' as const,
          toolName: typeof legacyLog.toolName === 'string' ? legacyLog.toolName : '',
          callId: typeof legacyLog.callId === 'string' ? legacyLog.callId : '',
          expectedSucceeded: legacyLog.expectedSucceeded === true,
          matched: legacyLog.matched === true,
        }
        : null)
      this.claimAudits.set(audit.auditId, {
        ...audit,
        anchor,
        // Current rows carry anchorVerified; legacy rows carry logVerified.
        anchorVerified: rawAudit.anchorVerified === true || rawAudit.logVerified === true,
      })
      const seq = Number(audit.auditId.replace('audit_', ''))
      if (Number.isFinite(seq)) this.nextAuditSeq = Math.max(this.nextAuditSeq, seq + 1)
    }
    if (triggerJumps !== '') {
      const parsed = JSON.parse(triggerJumps) as unknown
      if (Array.isArray(parsed)) {
        for (const record of parsed) {
          if (typeof record !== 'object' || record === null) continue
          const jump = record as TriggerJump
          if (typeof jump.jumpWord !== 'string' || jump.jumpWord.length === 0) continue
          this.triggerJumps.set(jump.jumpWord, jump)
        }
      }
    }
    for (const record of parseLines(injections)) {
      if (typeof record !== 'object' || record === null) continue
      const injection = record as InjectionRecord
      if (typeof injection.injectionId !== 'string') continue
      this.injections.set(injection.injectionId, injection)
      const seq = Number(injection.injectionId.replace('inject_', ''))
      if (Number.isFinite(seq)) this.nextInjectionSeq = Math.max(this.nextInjectionSeq, seq + 1)
    }
    if (chains !== '') {
      const parsed = JSON.parse(chains) as unknown
      if (Array.isArray(parsed)) {
        for (const record of parsed) {
          if (typeof record !== 'object' || record === null) continue
          const chain = record as ChainExperience
          if (typeof chain.chainId !== 'string' || chain.chainId.length === 0) continue
          // Legacy rows predate the tree edges; normalize the required field.
          const rawChain = record as { childChainIds?: readonly string[] }
          this.chains.set(chain.chainId, {
            ...chain,
            childChainIds: rawChain.childChainIds === undefined ? [] : rawChain.childChainIds,
          })
        }
      }
    }
    if (chainPatterns !== '') {
      const parsed = JSON.parse(chainPatterns) as unknown
      if (Array.isArray(parsed)) {
        for (const record of parsed) {
          if (typeof record !== 'object' || record === null) continue
          const pattern = record as ChainPattern
          if (typeof pattern.patternId !== 'string' || pattern.patternId.length === 0) continue
          this.chainPatterns.set(pattern.patternId, pattern)
        }
      }
    }
    if (solidifiedStrategies !== '') {
      const parsed = JSON.parse(solidifiedStrategies) as unknown
      if (Array.isArray(parsed)) {
        for (const record of parsed) {
          if (typeof record !== 'object' || record === null) continue
          const strategy = record as SolidifiedStrategy
          if (typeof strategy.strategyId !== 'string' || strategy.strategyId.length === 0) continue
          this.solidifiedStrategies.set(strategy.strategyId, strategy)
          const seq = Number(strategy.strategyId.replace('solidified-', ''))
          if (Number.isFinite(seq)) this.nextStrategySeq = Math.max(this.nextStrategySeq, seq + 1)
        }
      }
    }
    if (variants !== '') {
      const parsed = JSON.parse(variants) as unknown
      if (Array.isArray(parsed)) {
        for (const record of parsed) {
          if (typeof record !== 'object' || record === null) continue
          const candidate = record as VariantCandidate
          if (typeof candidate.variantId !== 'string' || candidate.variantId.length === 0) continue
          this.variants.set(candidate.variantId, candidate)
          const seq = Number(candidate.variantId.replace('variant-', ''))
          if (Number.isFinite(seq)) this.nextVariantSeq = Math.max(this.nextVariantSeq, seq + 1)
        }
      }
    }
    if (taxonomy !== '') {
      const parsed = JSON.parse(taxonomy) as unknown
      if (typeof parsed === 'object' && parsed !== null && typeof (parsed as Record<string, unknown>).version === 'number') {
        const rawRules = Array.isArray((parsed as Record<string, unknown>).rules)
          ? (parsed as Record<string, unknown>).rules as unknown[]
          : []
        this.taxonomyState = {
          ...parsed as unknown as TaxonomyState,
          rules: rawRules
            .filter((rule): rule is Record<string, unknown> => typeof rule === 'object' && rule !== null)
            .map((rule) => {
              const polarityRaw = rule.polarity
              const hasPolarity = polarityRaw === 'success' || polarityRaw === 'risk'
              const rangeLow = typeof rule.utilityRange === 'object' && rule.utilityRange !== null
                ? Number((rule.utilityRange as Record<string, unknown>).low)
                : 0
              return {
                condition: typeof rule.condition === 'string' ? rule.condition : '',
                action: typeof rule.action === 'string' ? rule.action : '',
                utilityRange: {
                  low: Number.isFinite(rangeLow) ? rangeLow : 0,
                  high: typeof rule.utilityRange === 'object' && rule.utilityRange !== null
                    ? Number((rule.utilityRange as Record<string, unknown>).high)
                    : 10,
                },
                polarity: hasPolarity
                  ? polarityRaw
                  : (Number.isFinite(rangeLow) && rangeLow >= 5 ? 'success' : 'risk'),
              }
            }),
        }
      }
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

  /**
   * Fold one real-feedback evidence weight into a simulated experience's
   * verification state (the evidence-replacement model): a single decisive
   * weight fast-tracks to provisional, cumulative evidence upgrades to
   * verified, and a contradictory provisional feedback rolls back. Ordinary
   * experiences are verified by construction and unaffected.
   * @param expId - the experience id.
   * @param weight - the feedback evidence weight in [0, 1].
   * @param contradictory - whether the feedback contradicts the simulation.
   * @param fastTrackThreshold - weight at/above which one feedback fast-tracks.
   * @param permanentThreshold - cumulative evidence needed for permanent verified.
   * @returns the updated experience.
   */
  applyFeedbackEvidence(
    expId: string,
    weight: number,
    contradictory: boolean,
    fastTrackThreshold: number,
    permanentThreshold: number,
  ): Experience {
    const current = this.getExperience(expId)
    if (current === undefined) {
      throw new Error(`cognitive-pipeline: experience "${expId}" not found`)
    }
    if (!current.simulated || current.verification === 'verified') return current
    if (contradictory && current.verification === 'provisional') {
      // The observation window caught a contradiction: roll back to unverified
      // and do not count the contradictory weight.
      const rolled = { ...current, verification: 'unverified' as const, evidenceScore: 0 }
      this.experiences.set(expId, rolled)
      this.enqueueLines('experiences.jsonl', [...this.experiences.values()])
      return rolled
    }
    const nextScore = current.evidenceScore + weight
    // A single decisive feedback fast-tracks to provisional; cumulative
    // evidence at or above the permanent threshold upgrades to verified.
    const verification = nextScore >= permanentThreshold
      ? 'verified' as const
      : (weight >= fastTrackThreshold || current.verification === 'provisional')
        ? 'provisional' as const
        : 'unverified' as const
    const next: Experience = {
      ...current,
      evidenceScore: nextScore,
      verification,
    }
    this.experiences.set(expId, next)
    this.enqueueLines('experiences.jsonl', [...this.experiences.values()])
    return next
  }

  /**
   * Expire simulated experiences that never earned real feedback within the
   * fallback TTL. This is the backstop of the evidence-replacement model:
   * verification and density are primary, the timeout guards the
   * never-verified corner.
   * @param now - the reference timestamp.
   * @param ttlMs - the fallback TTL for unverified simulated experiences.
   * @returns the expIds removed.
   */
  expireUnverifiedSimulated(now: number, ttlMs: number): string[] {
    const expired: string[] = []
    for (const exp of this.experiences.values()) {
      if (exp.simulated && exp.verification === 'unverified' && now - exp.timestamp >= ttlMs) {
        this.experiences.delete(exp.expId)
        expired.push(exp.expId)
      }
    }
    if (expired.length > 0) {
      this.enqueueLines('experiences.jsonl', [...this.experiences.values()])
    }
    return expired
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
   * prediction error to the bound experience's cumulative error. When the
   * feedback carries a result-quality label, it is folded back into the bound
   * experience's utility so "predicted wrong but quality known" experiences
   * carry a real tag instead of staying neutral.
   * @param predictionId - the prediction to resolve.
   * @param actualOutcome - the observed outcome text.
   * @param predictionError - absolute error in [0, 1].
   * @param outcomeQuality - optional result quality 0-10 to fold into the bound experience.
   * @param disequilibriumGate - optional gate parameters; when supplied, each
   * quality-carrying settlement is judged against the prior sample
   * distribution and a threshold-crossing deviation flags the experience.
   * @returns the resolved prediction.
   */
  resolvePrediction(
    predictionId: string,
    actualOutcome: string,
    predictionError: number,
    outcomeQuality?: number,
    disequilibriumGate?: { zThreshold: number; minSamples: number },
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
        const utility = outcomeQuality === undefined
          ? exp.sar.outcomeUtility
          : {
            ...exp.sar.outcomeUtility,
            // The single quality axis maps to material gain; the emotional and
            // cost axes are not conveyed by feedback and keep their recorded
            // values. 5 + (q-5)*0.8: q=8 → 7, q=2 → 3 — a neutral 5/5/5 gains
            // a real label after the first resolved prediction.
            materialGain: clampLabel(5 + (outcomeQuality - 5) * 0.8),
          }
        const next: Experience = {
          ...exp,
          predictionError,
          cumulativeError: exp.cumulativeError + predictionError,
          sar: { ...exp.sar, outcomeUtility: utility },
          // One variance-ledger sample per quality-carrying settlement: the
          // raw quality (un-scaled) is appended, so the distribution over
          // samples measures how uncertain this experience's result really is.
          // The disequilibrium gate judges the new sample against the prior
          // distribution; a threshold-crossing deviation flags the experience
          // as an accommodation candidate (result distribution shifted).
          ...outcomeQuality === undefined ? {} : (() => {
            const prior = exp.settlements ?? []
            const gate = disequilibriumGate ?? {
              zThreshold: DEFAULT_DISEQUILIBRIUM_Z,
              minSamples: DEFAULT_DISEQUILIBRIUM_MIN_SAMPLES,
            }
            const judgment = disequilibriumOf(prior, outcomeQuality, gate.zThreshold, gate.minSamples)
            return {
              settlements: [...prior, { ts: now, quality: outcomeQuality }],
              ...judgment !== null && judgment.disequilibrated ? {
                disequilibrium: { atTs: now, sampleQuality: outcomeQuality, zScore: judgment.zScore },
              } : {},
            }
          })(),
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

  // ── multi-channel retrieval weights ──────────────────────────────────────

  /** Snapshot of the learned retrieval channel weights.
   * @returns a detached weight record.
   */
  channelWeightsSnapshot(): ChannelWeights {
    return { ...this.channelWeights }
  }

  /** Apply one EWMA step to the learned retrieval channel weights.
   * @param weights - the new weights; each must already be clamped.
   */
  updateChannelWeights(weights: ChannelWeights): void {
    this.channelWeights = { ...weights }
    this.enqueue('channel_weights.json', this.channelWeights)
  }

  // ── active exploration ───────────────────────────────────────────────────

  /** Snapshot of the exploration state with the current window's usage.
   * @returns the exploration state (used counts reset for a stale date).
   */
  explorationSnapshot(): ExplorationState {
    if (this.explorationState.date !== todayKey()) {
      return { date: todayKey(), used: 0, entries: [...this.explorationState.entries] }
    }
    return { date: this.explorationState.date, used: this.explorationState.used, entries: [...this.explorationState.entries] }
  }

  /** Record one exploration attempt within the current budget window.
   * @param entry - the exploration entry to append.
   */
  recordExploration(entry: ExploreEntry): void {
    const current = this.explorationSnapshot()
    this.explorationState = {
      date: current.date,
      used: current.used + 1,
      entries: [...current.entries, entry],
    }
    this.enqueue('exploration.json', this.explorationState)
  }

  /** Mark an exploration entry's scratchpad terminal outcome.
   * @param scratchpadHash - the tracked scratchpad signature hash.
   * @param outcome - 'graduated' or 'expired'.
   */
  resolveExploration(scratchpadHash: string, outcome: 'graduated' | 'expired'): void {
    const current = this.explorationSnapshot()
    const updated = current.entries.map(entry =>
      entry.scratchpadHash === scratchpadHash && entry.outcome === null
        ? { ...entry, outcome }
        : entry)
    if (updated.some((entry, index) => entry !== current.entries[index])) {
      this.explorationState = { date: current.date, used: current.used, entries: updated }
      this.enqueue('exploration.json', this.explorationState)
    }
  }

  /**
   * Fold one real-world prediction error back into an exploration entry's ROI
   * ledger. Called on every feedback for a prediction that reused the entry's
   * scratchpad: the error (|calibrated − observed| of that reuse) updates the
   * entry's EWMA, and the entry flips validated/refuted once its EWMA clears
   * or crosses the threshold. This is the feedback chain that closes the
   * meta-cognition loop — an exploration is not merely graduated (it became a
   * strategy) but measured (did reusing it actually reduce prediction error).
   * @param scratchpadHash - the scratchpad the resolved prediction reused.
   * @param predictionError - the reuse prediction's absolute error in [0, 1].
   * @param learningRate - EWMA step for the fold.
   * @param errorThreshold - error ceiling: below validates, at/above refutes.
   * @returns the updated entry, or undefined when the hash tracks no entry.
   */
  validateExploration(
    scratchpadHash: string,
    predictionError: number,
    learningRate: number,
    errorThreshold: number,
  ): ExploreEntry | undefined {
    const current = this.explorationSnapshot()
    const target = current.entries.find(entry => entry.scratchpadHash === scratchpadHash)
    if (target === undefined) return undefined
    const validatedError = target.validatedError === null
      ? predictionError
      : (1 - learningRate) * target.validatedError + learningRate * predictionError
    const entries = current.entries.map(entry =>
      entry.scratchpadHash === scratchpadHash
        ? { ...entry, validatedError, validated: validatedError < errorThreshold }
        : entry)
    this.explorationState = { date: current.date, used: current.used, entries }
    this.enqueue('exploration.json', this.explorationState)
    return entries.find(entry => entry.scratchpadHash === scratchpadHash)
  }

  // ── autonomous exploration tasks ─────────────────────────────────────────

  /** Snapshot of every queued exploration task, insertion order.
   * @returns the task list.
   */
  explorationTasksSnapshot(): readonly ExplorationTask[] {
    return [...this.explorationTasks.values()]
  }

  /** Queue one autonomous exploration task.
   * @param goal - the exploration goal a background session will pursue.
   * @returns the new task.
   */
  addExplorationTask(goal: string): ExplorationTask {
    const task: ExplorationTask = {
      taskId: `task_${this.nextTaskSeq}`,
      goal,
      status: 'pending',
      createdAt: Date.now(),
      pickedUpAt: null,
      result: null,
    }
    this.nextTaskSeq += 1
    this.explorationTasks.set(task.taskId, task)
    this.enqueue('exploration_tasks.json', [...this.explorationTasks.values()])
    return task
  }

  /** Transition one task's status, recording pickup time and the result.
   * @param taskId - the task to update.
   * @param patch - the status/pickedUpAt/result fields to apply.
   * @returns the updated task, or undefined when unknown.
   */
  updateExplorationTask(
    taskId: string,
    patch: { status?: ExplorationTaskStatus; pickedUpAt?: number | null; result?: string | null },
  ): ExplorationTask | undefined {
    const current = this.explorationTasks.get(taskId)
    if (current === undefined) return undefined
    const next: ExplorationTask = { ...current, ...patch }
    this.explorationTasks.set(taskId, next)
    this.enqueue('exploration_tasks.json', [...this.explorationTasks.values()])
    return next
  }

  // ── loop execution receipts ──────────────────────────────────────────────

  /** Store one loop-execution receipt and enqueue its persistence.
   * @param receipt - the receipt to add (id must be unique).
   */
  addLoopExecution(receipt: LoopExecutionReceipt): void {
    this.loopExecutions.set(receipt.receiptId, receipt)
    this.enqueueLines('loop_executions.jsonl', [...this.loopExecutions.values()])
  }

  /** Read one loop-execution receipt by id.
   * @param receiptId - the receipt id (`<predictionId>@<target>`).
   * @returns the receipt, or undefined when unknown.
   */
  getLoopExecution(receiptId: string): LoopExecutionReceipt | undefined {
    return this.loopExecutions.get(receiptId)
  }

  /** Snapshot of every loop-execution receipt, insertion order.
   * @returns the receipt list.
   */
  loopExecutionsSnapshot(): readonly LoopExecutionReceipt[] {
    return [...this.loopExecutions.values()]
  }

  /** Mark one accepted receipt's terminal execution outcome. Refused receipts
   * are terminal by construction and are never settled.
   * @param receiptId - the receipt to settle.
   * @param status - the terminal outcome ('executed' or 'failed').
   * @param outcomeText - what the execution actually produced.
   * @param outcomeQuality - the outcome quality 0–10.
   * @returns the updated receipt, or undefined when unknown.
   */
  settleLoopExecution(
    receiptId: string,
    status: 'executed' | 'failed',
    outcomeText: string,
    outcomeQuality: number,
  ): LoopExecutionReceipt | undefined {
    const current = this.loopExecutions.get(receiptId)
    if (current === undefined) return undefined
    const next: LoopExecutionReceipt = {
      ...current,
      status,
      settledAt: Date.now(),
      outcomeText,
      outcomeQuality,
    }
    this.loopExecutions.set(receiptId, next)
    this.enqueueLines('loop_executions.jsonl', [...this.loopExecutions.values()])
    return next
  }

  // ── acceptance criteria + claim audits ───────────────────────────────────

  /** Allocate the next acceptance-check id.
   * @returns `check_<n>`.
   */
  nextAcceptanceCheckId(): string {
    const id = `check_${this.nextAcceptanceSeq}`
    this.nextAcceptanceSeq += 1
    return id
  }

  /** Allocate the next claim-audit id.
   * @returns `audit_<n>`.
   */
  nextAuditId(): string {
    const id = `audit_${this.nextAuditSeq}`
    this.nextAuditSeq += 1
    return id
  }

  /** The next solidified-strategy id.
   * @returns `solidified-<n>`.
   */
  nextSolidifiedStrategyId(): string {
    const id = `solidified-${this.nextStrategySeq}`
    this.nextStrategySeq += 1
    return id
  }

  /** Store one acceptance criterion and enqueue its persistence.
   * @param check - the criterion to add.
   */
  addAcceptanceCheck(check: AcceptanceCheck): void {
    this.acceptance.set(check.checkId, check)
    this.enqueue('acceptance.json', [...this.acceptance.values()])
  }

  /** Read one acceptance criterion by id.
   * @param checkId - the criterion id.
   * @returns the criterion, or undefined.
   */
  getAcceptanceCheck(checkId: string): AcceptanceCheck | undefined {
    return this.acceptance.get(checkId)
  }

  /** Snapshot of every acceptance criterion, insertion order.
   * @returns the criterion list.
   */
  acceptanceSnapshot(): readonly AcceptanceCheck[] {
    return [...this.acceptance.values()]
  }

  /** Apply a partial patch to one acceptance criterion. The domain freeze
   * (retired checks are immutable) is enforced by the service layer; the store
   * applies any patch it receives.
   * @param checkId - the criterion id.
   * @param patch - the fields to replace.
   * @returns the updated criterion.
   */
  updateAcceptanceCheck(checkId: string, patch: Partial<AcceptanceCheck>): AcceptanceCheck {
    const current = this.acceptance.get(checkId)
    if (current === undefined) {
      throw new Error(`cognitive-pipeline: acceptance check "${checkId}" not found`)
    }
    const next: AcceptanceCheck = { ...current, ...patch }
    this.acceptance.set(checkId, next)
    this.enqueue('acceptance.json', [...this.acceptance.values()])
    return next
  }

  /** Record one claim audit and enqueue its persistence.
   * @param audit - the audit to add (id must be unique).
   */
  recordClaimAudit(audit: ClaimAudit): void {
    this.claimAudits.set(audit.auditId, audit)
    this.enqueueLines('claim_audits.jsonl', [...this.claimAudits.values()])
  }

  /** Snapshot of every claim audit, insertion order.
   * @returns the audit list.
   */
  claimAuditsSnapshot(): readonly ClaimAudit[] {
    return [...this.claimAudits.values()]
  }

  /** Fold one audit's verdict into one criterion's evidence ledger: invoked
   * always increments, and the audit counts as passed (evidence present) or
   * violated (no evidence). Passes backed by a matched external-witness anchor
   * (a session-log tool call or a workspace file state) additionally increment
   * the machine-verified counter, so the ledger separates machine-witnessed
   * satisfaction from self-reported satisfaction.
   * @param checkId - the applied criterion.
   * @param passed - whether the claim carried evidence for it.
   * @param machineVerified - whether that evidence was a matched external anchor.
   * @returns the updated criterion.
   */
  applyAuditStats(checkId: string, passed: boolean, machineVerified: boolean = false): AcceptanceCheck {
    const current = this.acceptance.get(checkId)
    if (current === undefined) {
      throw new Error(`cognitive-pipeline: acceptance check "${checkId}" not found`)
    }
    const next: AcceptanceCheck = {
      ...current,
      invokedCount: current.invokedCount + 1,
      passedCount: current.passedCount + (passed ? 1 : 0),
      violatedCount: current.violatedCount + (passed ? 0 : 1),
      machineVerifiedCount: current.machineVerifiedCount + (passed && machineVerified ? 1 : 0),
    }
    this.acceptance.set(checkId, next)
    this.enqueue('acceptance.json', [...this.acceptance.values()])
    return next
  }

  /** Fold one resolved prediction's |calibrated − observed| error into a
   * criterion's deviation ledger. Only called for audits that violated the
   * criterion, so the ledger measures "claims made without verification
   * correlate with prediction error" on the same ruler as every prediction.
   * @param checkId - the violated criterion.
   * @param predictionError - the resolved prediction's absolute error in [0, 1].
   * @returns the updated criterion.
   */
  foldAcceptanceError(checkId: string, predictionError: number): AcceptanceCheck {
    const current = this.acceptance.get(checkId)
    if (current === undefined) {
      throw new Error(`cognitive-pipeline: acceptance check "${checkId}" not found`)
    }
    const next: AcceptanceCheck = {
      ...current,
      cumulativeError: current.cumulativeError + predictionError,
      errorFoldCount: current.errorFoldCount + 1,
    }
    this.acceptance.set(checkId, next)
    this.enqueue('acceptance.json', [...this.acceptance.values()])
    return next
  }

  // ── trigger jumps + injection records ─────────────────────────────────────

  /** Upsert one trigger-jump association (keyed by jump word).
   * @param jump - the jump to add or replace.
   */
  upsertTriggerJump(jump: TriggerJump): void {
    this.triggerJumps.set(jump.jumpWord, jump)
    this.enqueue('trigger_jumps.json', [...this.triggerJumps.values()])
  }

  /** Read one trigger jump by jump word.
   * @param jumpWord - the jump word.
   * @returns the jump, or undefined.
   */
  getTriggerJump(jumpWord: string): TriggerJump | undefined {
    return this.triggerJumps.get(jumpWord)
  }

  /** Snapshot of every trigger jump, insertion order.
   * @returns the jump list.
   */
  triggerJumpsSnapshot(): readonly TriggerJump[] {
    return [...this.triggerJumps.values()]
  }

  /** Replace the whole trigger-jump table (a rebuild replaces the structure;
   * the service carries citation stats across the rebuild).
   * @param jumps - the new table.
   */
  replaceTriggerJumps(jumps: readonly TriggerJump[]): void {
    this.triggerJumps = new Map(jumps.map(jump => [jump.jumpWord, jump]))
    this.enqueue('trigger_jumps.json', [...this.triggerJumps.values()])
  }

  /** Allocate the next injection-record id.
   * @returns `inject_<n>`.
   */
  nextInjectionId(): string {
    const id = `inject_${this.nextInjectionSeq}`
    this.nextInjectionSeq += 1
    return id
  }

  /** Record one injection event.
   * @param record - the injection to add (id must be unique).
   */
  recordInjection(record: InjectionRecord): void {
    this.injections.set(record.injectionId, record)
    this.enqueueLines('injections.jsonl', [...this.injections.values()])
  }

  /** Snapshot of every injection record, insertion order.
   * @returns the injection list.
   */
  injectionsSnapshot(): readonly InjectionRecord[] {
    return [...this.injections.values()]
  }

  /** Settle one injection's citation outcome.
   * @param injectionId - the injection to settle.
   * @param cited - whether a later assistant message referenced an injected expId.
   */
  settleInjection(injectionId: string, cited: boolean): void {
    const current = this.injections.get(injectionId)
    if (current === undefined || current.cited !== null) return
    this.injections.set(injectionId, { ...current, cited })
    this.enqueueLines('injections.jsonl', [...this.injections.values()])
  }

  /** Fold one settled injection's citation outcome into the contributing jump
   * words' measured-utility ledger (hitCount always, citedCount when cited).
   * @param jumpWords - the jump words that contributed to the trigger.
   * @param cited - whether the injection was cited.
   */
  foldJumpCitation(jumpWords: readonly string[], cited: boolean): void {
    if (jumpWords.length === 0) return
    let changed = false
    for (const word of jumpWords) {
      const jump = this.triggerJumps.get(word)
      if (jump === undefined) continue
      this.triggerJumps.set(word, {
        ...jump,
        hitCount: jump.hitCount + 1,
        citedCount: jump.citedCount + (cited ? 1 : 0),
        updatedAt: Date.now(),
      })
      changed = true
    }
    if (changed) this.enqueue('trigger_jumps.json', [...this.triggerJumps.values()])
  }

  // ── chains (the derived cognition object: goal-anchored causal skeletons) ──

  /** Upsert one chain (keyed by chain id).
   * @param chain - the chain to add or replace.
   */
  upsertChain(chain: ChainExperience): void {
    this.chains.set(chain.chainId, chain)
    this.enqueue('chains.json', [...this.chains.values()])
  }

  /** Read one chain by id.
   * @param chainId - the chain id.
   * @returns the chain, or undefined.
   */
  getChain(chainId: string): ChainExperience | undefined {
    return this.chains.get(chainId)
  }

  /** Snapshot of every chain, insertion order.
   * @returns the chain list.
   */
  chainsSnapshot(): readonly ChainExperience[] {
    return [...this.chains.values()]
  }

  /** Replace the whole chain table (a rebuild re-projects chains from tagged
   * experiences; the service carries citation stats across the rebuild).
   * @param chains - the new table.
   */
  replaceChains(chains: readonly ChainExperience[]): void {
    this.chains = new Map(chains.map(chain => [chain.chainId, chain]))
    this.enqueue('chains.json', [...this.chains.values()])
  }

  /** Fold one settled chain injection's citation outcome into the chain's
   * measured-utility ledger (hitCount always, citedCount when cited).
   * @param chainId - the chain that was injected.
   * @param cited - whether the injection was cited.
   */
  foldChainCitation(chainId: string, cited: boolean): void {
    const chain = this.chains.get(chainId)
    if (chain === undefined) return
    this.chains.set(chainId, {
      ...chain,
      hitCount: chain.hitCount + 1,
      citedCount: chain.citedCount + (cited ? 1 : 0),
      updatedAt: Date.now(),
    })
    this.enqueue('chains.json', [...this.chains.values()])
  }

  /** Read one chain pattern by id (its structural signature).
   * @param patternId - the signature-based pattern id.
   * @returns the pattern, or undefined.
   */
  getChainPattern(patternId: string): ChainPattern | undefined {
    return this.chainPatterns.get(patternId)
  }

  /** Snapshot of every chain pattern, insertion order.
   * @returns the pattern list.
   */
  chainPatternsSnapshot(): readonly ChainPattern[] {
    return [...this.chainPatterns.values()]
  }

  /** Replace the whole chain-pattern table (a rebuild re-projects patterns
   * from chains).
   * @param patterns - the new table.
   */
  replaceChainPatterns(patterns: readonly ChainPattern[]): void {
    this.chainPatterns = new Map(patterns.map(pattern => [pattern.patternId, pattern]))
    this.enqueue('chain_patterns.json', [...this.chainPatterns.values()])
  }

  /** Recompute one pattern's measured utility from its member chains' current
   * citation stats (called by the pattern kind's measure, so a chain citation
   * settlement refreshes the pattern aggregate).
   * @param patternId - the signature-based pattern id.
   */
  recomputeChainPatternStats(patternId: string): void {
    const pattern = this.chainPatterns.get(patternId)
    if (pattern === undefined) return
    let hitCount = 0
    let citedCount = 0
    for (const chainId of pattern.chainIds) {
      const chain = this.chains.get(chainId)
      if (chain === undefined) continue
      hitCount += chain.hitCount
      citedCount += chain.citedCount
    }
    this.chainPatterns.set(patternId, { ...pattern, hitCount, citedCount, updatedAt: Date.now() })
    this.enqueue('chain_patterns.json', [...this.chainPatterns.values()])
  }

  // ── solidified strategies ─────────────────────────────────────────────────

  /** Read one solidified strategy by id.
   * @param strategyId - the strategy id.
   * @returns the strategy, or undefined.
   */
  getSolidifiedStrategy(strategyId: string): SolidifiedStrategy | undefined {
    return this.solidifiedStrategies.get(strategyId)
  }

  /** Read the solidified strategy serving one goal domain, if any.
   * @param goalDomain - the goal domain key (e.g. `重启`).
   * @returns the strategy, or undefined.
   */
  getSolidifiedStrategyByDomain(goalDomain: string): SolidifiedStrategy | undefined {
    return [...this.solidifiedStrategies.values()].find(strategy => strategy.goalDomain === goalDomain)
  }

  /** Snapshot of every solidified strategy, insertion order.
   * @returns the strategy list.
   */
  solidifiedStrategiesSnapshot(): readonly SolidifiedStrategy[] {
    return [...this.solidifiedStrategies.values()]
  }

  /** Add or replace one solidified strategy.
   * @param strategy - the strategy to persist.
   */
  upsertSolidifiedStrategy(strategy: SolidifiedStrategy): void {
    this.solidifiedStrategies.set(strategy.strategyId, strategy)
    this.enqueue('solidified_strategies.json', [...this.solidifiedStrategies.values()])
  }

  /** Fold one usage outcome into a strategy's lifecycle ledger: every use
   * increments hitCount; a positive outcome (verification anchor held) also
   * increments positiveCount; a failure (anchor failed or a pre-check tripped)
   * increments violatedCount and flags rework when the deviation gate crosses
   * (≥3 invoked, ≥50% violated — the acceptance-criteria gate shape).
   * @param strategyId - the strategy id.
   * @param positive - whether the use ended with the anchor holding.
   */
  foldSolidifiedStrategyUsage(strategyId: string, positive: boolean): void {
    const strategy = this.solidifiedStrategies.get(strategyId)
    if (strategy === undefined) return
    const hitCount = strategy.hitCount + 1
    const positiveCount = strategy.positiveCount + (positive ? 1 : 0)
    const violatedCount = strategy.violatedCount + (positive ? 0 : 1)
    const invoked = hitCount
    const reworkNeeded = invoked >= 3 && violatedCount / invoked >= 0.5
    this.solidifiedStrategies.set(strategyId, {
      ...strategy,
      hitCount,
      positiveCount,
      violatedCount,
      reworkNeeded,
      updatedAt: Date.now(),
    })
    this.enqueue('solidified_strategies.json', [...this.solidifiedStrategies.values()])
  }

  /** Allocate the next variant id.
   * @returns `variant-<n>`.
   */
  nextVariantId(): string {
    const id = `variant-${this.nextVariantSeq}`
    this.nextVariantSeq += 1
    return id
  }

  /** Snapshot of every variant candidate, insertion order.
   * @returns the candidate list.
   */
  variantsSnapshot(): readonly VariantCandidate[] {
    return [...this.variants.values()]
  }

  /** Add one variant candidate.
   * @param candidate - the candidate to persist.
   */
  addVariantCandidate(candidate: VariantCandidate): void {
    this.variants.set(candidate.variantId, candidate)
    this.enqueue('variants.json', [...this.variants.values()])
  }

  /** Replace one variant candidate (lifecycle transition or settlement append).
   * @param candidate - the updated candidate.
   */
  updateVariantCandidate(candidate: VariantCandidate): void {
    this.variants.set(candidate.variantId, candidate)
    this.enqueue('variants.json', [...this.variants.values()])
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
   * @returns experience, prediction, resolved, and settlement-ledger counts.
   */
  stats(): {
    experienceCount: number
    predictionCount: number
    resolvedPredictionCount: number
    settlement: {
      sampleCount: number
      sampledExperienceCount: number
      multiSampleExperienceCount: number
      disequilibratedExperienceCount: number
    }
  } {
    let resolved = 0
    for (const prediction of this.predictions.values()) {
      if (prediction.resolvedAt !== null) resolved += 1
    }
    let sampleCount = 0
    let sampledExperienceCount = 0
    let multiSampleExperienceCount = 0
    let disequilibratedExperienceCount = 0
    for (const exp of this.experiences.values()) {
      const samples = exp.settlements ?? []
      if (samples.length === 0) continue
      sampleCount += samples.length
      sampledExperienceCount += 1
      if (samples.length >= 2) multiSampleExperienceCount += 1
      if (exp.disequilibrium !== undefined) disequilibratedExperienceCount += 1
    }
    return {
      experienceCount: this.experiences.size,
      predictionCount: this.predictions.size,
      resolvedPredictionCount: resolved,
      settlement: { sampleCount, sampledExperienceCount, multiSampleExperienceCount, disequilibratedExperienceCount },
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

  /** Derive a normalized cluster view when the on-disk row predates the new
   * polarity / situationCentroid fields: polarity from the expected utility
   * range, centroid from the supporting experiences' situations.
   * @param raw - the loaded, still-untrusted cluster row.
   * @returns the cluster with both new fields present.
   */
  private normalizeCluster(raw: Record<string, unknown>): Cluster {
    const polarityRaw = raw.polarity
    const hasPolarity = polarityRaw === 'success' || polarityRaw === 'risk'
    const centroidRaw = raw.situationCentroid
    const hasCentroid = Array.isArray(centroidRaw) && centroidRaw.length > 0
    if (hasPolarity && hasCentroid) {
      return raw as unknown as Cluster
    }
    const evidenceIds = Array.isArray(raw.supportingEvidenceIds)
      ? raw.supportingEvidenceIds.filter((id): id is string => typeof id === 'string')
      : []
    const members = evidenceIds
      .map(id => this.experiences.get(id))
      .filter((exp): exp is Experience => exp !== undefined)
    const rangeLow = typeof raw.expectedUtilityRange === 'object' && raw.expectedUtilityRange !== null
      ? Number((raw.expectedUtilityRange as Record<string, unknown>).low)
      : 0
    const polarity: 'success' | 'risk' = hasPolarity
      ? polarityRaw
      : (Number.isFinite(rangeLow) && rangeLow >= 5 ? 'success' : 'risk')
    return {
      ...raw as unknown as Cluster,
      polarity,
      // Keep the dimension contract even when no evidence resolves: a zero
      // vector simply never matches a situation in the hot loop.
      situationCentroid: members.length === 0
        ? new Array<number>(ACTION_VECTOR_DIM).fill(0)
        : centroidOf(members.map(member => actionVector(member.sar.situation, []))),
    }
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

/** Mean of L2-normalized vectors (centroid), re-normalized; zero input stays zero. */
function centroidOf(vectors: readonly (readonly number[])[]): number[] {
  const dim = vectors[0]?.length ?? 0
  if (dim === 0) return []
  const sum = new Array<number>(dim).fill(0)
  for (const vector of vectors) {
    for (let index = 0; index < dim; index += 1) {
      sum[index] = (sum[index] ?? 0) + (vector[index] ?? 0)
    }
  }
  const mean = sum.map(value => value / vectors.length)
  let norm = 0
  for (const value of mean) norm += value * value
  norm = Math.sqrt(norm)
  return norm < 1e-9 ? mean : mean.map(value => value / norm)
}

/** Clamp a feedback-derived utility axis into [0, 10] rounded to one decimal. */
function clampLabel(value: number): number {
  return Math.min(10, Math.max(0, Math.round(value * 10) / 10))
}
