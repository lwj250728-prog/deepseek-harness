/**
 * Deterministic vectorizer: hashed bag-of-words vectors for actions (the
 * retrieval axis) and utility-weighted vectors for outcomes (the clustering
 * axis). No external embedding service is required; the same text always
 * produces the same vector, which keeps the store, tests, and rebuilds
 * reproducible across processes.
 * @module @deepseek-ai/dsh-cognitive-pipeline/vectorizer
 */
import type { OutcomeUtility, SettlementSample } from './types.ts';
/** Action-vector dimension (the design's `all-MiniLM-L6-v2` stand-in). */
export declare const ACTION_VECTOR_DIM = 384;
/** Outcome-vector dimension: 3 utility slots + hashed outcome features. */
export declare const OUTCOME_VECTOR_DIM = 512;
/** Number of utility slots at the head of the outcome vector. */
export declare const UTILITY_SLOTS = 3;
/**
 * Build the situation vector: an independent 384-dim hashed bag for situation
 * text (constraint 6 — the situation gets its own representation instead of
 * being stuffed into the action vector). Same dimension as the action vector,
 * distinct hash space.
 * @param text - the situation text.
 * @returns a normalized SITUATION-dimension vector.
 */
export declare function situationVector(text: string): number[];
/** Default z-score threshold of the disequilibrium gate (μ±2σ, a ~5% tail
 * event under the normal approximation). */
export declare const DEFAULT_DISEQUILIBRIUM_Z = 2;
/** Default minimum prior samples before a distribution is trustworthy enough
 * to judge a deviation (a one- or two-sample "distribution" has no variance
 * signal, so no disequilibrium can fire below this). */
export declare const DEFAULT_DISEQUILIBRIUM_MIN_SAMPLES = 3;
/** Signed composite utility of an outcome: gains and valence minus cost.
 * @param utility - the outcome utility.
 * @returns a signed score in [-15, 15].
 */
export declare function utilityScore(utility: OutcomeUtility): number;
/** Whether an outcome counts as a positive hit for the frequency prior.
 * @param utility - the outcome utility.
 * @returns true when the composite score is positive.
 */
export declare function isPositiveOutcome(utility: OutcomeUtility): boolean;
/** Tri-state polarity of an outcome on the composite utility axis. */
export type OutcomePolarity = 'positive' | 'neutral' | 'negative';
/**
 * The disequilibrium gate: judge one new settlement sample against the prior
 * sample distribution. The prior must hold at least {@link minSamples} samples
 * or no judgment is made (a too-thin distribution carries no variance signal).
 * Deviation is the sample's z-score against the prior mean/stddev; when it
 * reaches {@link zThreshold} the result distribution has shifted, which is the
 * driver framework's accommodation trigger — the recorded strategy may need
 * re-evaluation instead of being assimilated as noise.
 * @param prior - the settlement samples before this one.
 * @param quality - the new sample's raw quality (0–10).
 * @param zThreshold - the z-score threshold (default 2).
 * @param minSamples - minimum prior sample count (default 3).
 * @returns the deviation judgment, or null when the prior is too thin.
 */
export declare function disequilibriumOf(prior: readonly SettlementSample[], quality: number, zThreshold?: number, minSamples?: number): {
    zScore: number;
    disequilibrated: boolean;
} | null;
/** Convergence verdict of a variant candidate's settlement distribution. */
export type VariantConvergenceVerdict = 'insufficient' | 'adopt' | 'reject' | 'keep-testing';
/**
 * The iterative-convergence gate for a variant candidate (driver framework,
 * mechanism 4): the candidate graduates only when its real-use result
 * distribution converges. Conservative by default: adopt requires a high mean
 * with no low outlier (all samples ≥ adoptMinQuality − 1 and mean ≥
 * adoptMinQuality), reject requires a clearly poor mean (≤ rejectMaxMean),
 * anything between keeps testing, and fewer than minSamples never judges.
 * @param settlements - the real-use samples accumulated so far.
 * @param adoptMinQuality - adoption mean floor (default 7).
 * @param rejectMaxMean - rejection mean ceiling (default 4).
 * @param minSamples - minimum samples before any verdict (default 3).
 * @returns the convergence verdict.
 */
export declare function variantConvergence(settlements: readonly SettlementSample[], adoptMinQuality?: number, rejectMaxMean?: number, minSamples?: number): VariantConvergenceVerdict;
/** Failure-symptom markers that make an experience recallable by its signature. */
export declare const SYMPTOM_MARKERS: string[];
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
export declare function symptomOverlap(query: string, text: string): number;
/**
 * Classify an outcome by composite score sign. A zero composite score (for
 * example the neutral 5/5/5 extraction, or a gain that exactly cancels its
 * cost) carries no net signal and must not be counted as a failure.
 * @param utility - the outcome utility.
 * @returns the polarity.
 */
export declare function outcomePolarity(utility: OutcomeUtility): OutcomePolarity;
/** FNV-1a 32-bit hash, a stable deterministic token hash.
 * @param token - the token to hash.
 * @returns an unsigned 32-bit hash.
 */
export declare function hashToken(token: string): number;
/** Tokenize text: lowercase latin/digit runs plus each CJK char separately.
 * @param text - the input text.
 * @returns the token list.
 */
export declare function tokenize(text: string): string[];
/** L2-normalize a vector; a zero vector stays zero.
 * @param vector - the input vector.
 * @returns a normalized copy.
 */
export declare function normalize(vector: readonly number[]): number[];
/** Cosine similarity between two vectors; a zero-norm pair scores 0.
 * @param a - the first vector.
 * @param b - the second vector.
 * @returns the cosine in [-1, 1].
 */
export declare function cosine(a: readonly number[], b: readonly number[]): number;
/** Build the action retrieval vector from action text plus keywords.
 * @param action - the action text.
 * @param keywords - SAR-extracted action keywords.
 * @returns a normalized ACTION_VECTOR_DIM vector.
 */
export declare function actionVector(action: string, keywords: readonly string[]): number[];
/**
 * Build the outcome clustering vector: three signed utility slots dominate the
 * head (weighted before normalization), and hashed outcome-text features fill
 * the tail. Clustering therefore groups by result *utility pattern*, not by
 * outcome wording.
 * @param utility - the quantified outcome utility.
 * @param outcomeText - the outcome description.
 * @returns a normalized OUTCOME_VECTOR_DIM vector.
 */
export declare function outcomeVector(utility: OutcomeUtility, outcomeText: string): number[];
/** Stable signature hash for one action text (temp-strategy keys).
 * @param action - the action text.
 * @returns the FNV hash value.
 */
export declare function signatureHash(action: string): number;
//# sourceMappingURL=vectorizer.d.ts.map