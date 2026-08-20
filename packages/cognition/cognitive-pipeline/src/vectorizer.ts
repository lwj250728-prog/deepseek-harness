/**
 * Deterministic vectorizer: hashed bag-of-words vectors for actions (the
 * retrieval axis) and utility-weighted vectors for outcomes (the clustering
 * axis). No external embedding service is required; the same text always
 * produces the same vector, which keeps the store, tests, and rebuilds
 * reproducible across processes.
 * @module @deepseek-ai/dsh-cognitive-pipeline/vectorizer
 */

import type { OutcomeUtility } from './types.ts'

/** Action-vector dimension (the design's `all-MiniLM-L6-v2` stand-in). */
export const ACTION_VECTOR_DIM = 384
/** Outcome-vector dimension: 3 utility slots + hashed outcome features. */
export const OUTCOME_VECTOR_DIM = 512
/** Number of utility slots at the head of the outcome vector. */
export const UTILITY_SLOTS = 3

/** Utility feature slots scale to [-1, 1]. */
const UTILITY_SCALE = 5
/**
 * Multiplier applied to the utility slots before normalization so the signed
 * utility pattern dominates the hashed outcome-text features — the "效用优先
 * 于语义" clustering principle of the design.
 */
const UTILITY_WEIGHT = 4

/** Signed composite utility of an outcome: gains and valence minus cost.
 * @param utility - the outcome utility.
 * @returns a signed score in [-15, 15].
 */
export function utilityScore(utility: OutcomeUtility): number {
  return (utility.materialGain - UTILITY_SCALE)
    + (utility.emotionalValence - UTILITY_SCALE)
    - (utility.energyCost - UTILITY_SCALE)
}

/** Whether an outcome counts as a positive hit for the frequency prior.
 * @param utility - the outcome utility.
 * @returns true when the composite score is positive.
 */
export function isPositiveOutcome(utility: OutcomeUtility): boolean {
  return utilityScore(utility) > 0
}

/** Tri-state polarity of an outcome on the composite utility axis. */
export type OutcomePolarity = 'positive' | 'neutral' | 'negative'

/** Failure-symptom markers that make an experience recallable by its signature. */
export const SYMPTOM_MARKERS = [
  '挂起', '死循环', '失败', '报错', '错误', '超时', '异常', '崩溃', '拒绝',
  '无法', '不能', '编译', '断言', '溢出', '泄漏', '锁死', '卡住', '闪退',
  'eperm', 'exit', 'timeout', 'error', 'fail', 'crash', 'hang',
]

/**
 * Fraction of the query's symptom markers that appear in one text. The
 * hashed bag-of-words vectors dilute short symptom queries against long
 * situations, so this exact-substring overlap is the complementary recall
 * channel: "测试挂起" hits an experience whose situation literally contains
 * 挂起 even when the vector cosine is low.
 * @param query - the query text (task summary, situation, etc.).
 * @param text - the candidate experience text.
 * @returns the matched-marker ratio in [0, 1].
 */
export function symptomOverlap(query: string, text: string): number {
  const lower = text.toLowerCase()
  let matched = 0
  let present = 0
  for (const marker of SYMPTOM_MARKERS) {
    if (!query.toLowerCase().includes(marker)) continue
    present += 1
    if (lower.includes(marker)) matched += 1
  }
  return present === 0 ? 0 : matched / present
}

/**
 * Classify an outcome by composite score sign. A zero composite score (for
 * example the neutral 5/5/5 extraction, or a gain that exactly cancels its
 * cost) carries no net signal and must not be counted as a failure.
 * @param utility - the outcome utility.
 * @returns the polarity.
 */
export function outcomePolarity(utility: OutcomeUtility): OutcomePolarity {
  const score = utilityScore(utility)
  if (score > 0) return 'positive'
  if (score < 0) return 'negative'
  return 'neutral'
}

/** FNV-1a 32-bit hash, a stable deterministic token hash.
 * @param token - the token to hash.
 * @returns an unsigned 32-bit hash.
 */
export function hashToken(token: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Whether one code point is a CJK unified ideograph. */
function isCjk(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return code >= 0x4e00 && code <= 0x9fff
}

/** Tokenize text: lowercase latin/digit runs plus each CJK char separately.
 * @param text - the input text.
 * @returns the token list.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  let latin = ''
  const flush = (): void => {
    if (latin.length > 0) {
      tokens.push(latin)
      latin = ''
    }
  }
  for (const char of text) {
    if (isCjk(char)) {
      flush()
      tokens.push(char)
    } else if (/[a-zA-Z0-9]/.test(char)) {
      latin += char.toLowerCase()
    } else {
      flush()
    }
  }
  flush()
  return tokens
}

/** Build an L2-normalized count bag over hashed tokens of one dimension. */
function bagVector(tokens: readonly string[], dim: number): number[] {
  const counts = new Array<number>(dim).fill(0)
  for (const token of tokens) {
    const slot = hashToken(token) % dim
    counts[slot] = (counts[slot] ?? 0) + 1
  }
  return normalize(counts)
}

/** L2-normalize a vector; a zero vector stays zero.
 * @param vector - the input vector.
 * @returns a normalized copy.
 */
export function normalize(vector: readonly number[]): number[] {
  let norm = 0
  for (const value of vector) norm += value * value
  norm = Math.sqrt(norm)
  if (norm < 1e-9) return vector.slice()
  return vector.map(value => value / norm)
}

/** Cosine similarity between two vectors; a zero-norm pair scores 0.
 * @param a - the first vector.
 * @param b - the second vector.
 * @returns the cosine in [-1, 1].
 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let aNorm = 0
  let bNorm = 0
  for (let index = 0; index < a.length; index += 1) {
    const av = a[index] ?? 0
    const bv = b[index] ?? 0
    dot += av * bv
    aNorm += av * av
    bNorm += bv * bv
  }
  const norm = Math.sqrt(aNorm) * Math.sqrt(bNorm)
  return norm < 1e-9 ? 0 : dot / norm
}

/** Build the action retrieval vector from action text plus keywords.
 * @param action - the action text.
 * @param keywords - SAR-extracted action keywords.
 * @returns a normalized ACTION_VECTOR_DIM vector.
 */
export function actionVector(action: string, keywords: readonly string[]): number[] {
  const tokens = [...tokenize(action), ...keywords.map(keyword => keyword.toLowerCase())]
  return bagVector(tokens, ACTION_VECTOR_DIM)
}

/**
 * Build the outcome clustering vector: three signed utility slots dominate the
 * head (weighted before normalization), and hashed outcome-text features fill
 * the tail. Clustering therefore groups by result *utility pattern*, not by
 * outcome wording.
 * @param utility - the quantified outcome utility.
 * @param outcomeText - the outcome description.
 * @returns a normalized OUTCOME_VECTOR_DIM vector.
 */
export function outcomeVector(utility: OutcomeUtility, outcomeText: string): number[] {
  const vector = new Array<number>(OUTCOME_VECTOR_DIM).fill(0)
  vector[0] = ((utility.materialGain - UTILITY_SCALE) / UTILITY_SCALE) * UTILITY_WEIGHT
  vector[1] = ((utility.emotionalValence - UTILITY_SCALE) / UTILITY_SCALE) * UTILITY_WEIGHT
  vector[2] = (-(utility.energyCost - UTILITY_SCALE) / UTILITY_SCALE) * UTILITY_WEIGHT
  const features = bagVector(tokenize(outcomeText), OUTCOME_VECTOR_DIM - UTILITY_SLOTS)
  for (let index = UTILITY_SLOTS; index < OUTCOME_VECTOR_DIM; index += 1) {
    vector[index] = features[index - UTILITY_SLOTS] ?? 0
  }
  return normalize(vector)
}

/** Stable signature hash for one action text (temp-strategy keys).
 * @param action - the action text.
 * @returns the FNV hash value.
 */
export function signatureHash(action: string): number {
  return hashToken(action.toLowerCase())
}
