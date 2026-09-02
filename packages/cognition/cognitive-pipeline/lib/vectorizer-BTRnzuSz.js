//#region lib/types/vectorizer.js
/**
* Deterministic vectorizer: hashed bag-of-words vectors for actions (the
* retrieval axis) and utility-weighted vectors for outcomes (the clustering
* axis). No external embedding service is required; the same text always
* produces the same vector, which keeps the store, tests, and rebuilds
* reproducible across processes.
* @module @deepseek-ai/dsh-cognitive-pipeline/vectorizer
*/
/** Action-vector dimension (the design's `all-MiniLM-L6-v2` stand-in). */
const ACTION_VECTOR_DIM = 384;
/** Outcome-vector dimension: 3 utility slots + hashed outcome features. */
const OUTCOME_VECTOR_DIM = 512;
/** Number of utility slots at the head of the outcome vector. */
const UTILITY_SLOTS = 3;
/** Utility feature slots scale to [-1, 1]. */
const UTILITY_SCALE = 5;
/**
* Multiplier applied to the utility slots before normalization so the signed
* utility pattern dominates the hashed outcome-text features — the "效用优先
* 于语义" clustering principle of the design.
*/
const UTILITY_WEIGHT = 4;
/** Signed composite utility of an outcome: gains and valence minus cost.
* @param utility - the outcome utility.
* @returns a signed score in [-15, 15].
*/
function utilityScore(utility) {
	return utility.materialGain - UTILITY_SCALE + (utility.emotionalValence - UTILITY_SCALE) - (utility.energyCost - UTILITY_SCALE);
}
/** Whether an outcome counts as a positive hit for the frequency prior.
* @param utility - the outcome utility.
* @returns true when the composite score is positive.
*/
function isPositiveOutcome(utility) {
	return utilityScore(utility) > 0;
}
/** Failure-symptom markers that make an experience recallable by its signature. */
const SYMPTOM_MARKERS = [
	"挂起",
	"死循环",
	"失败",
	"报错",
	"错误",
	"超时",
	"异常",
	"崩溃",
	"拒绝",
	"无法",
	"不能",
	"编译",
	"断言",
	"溢出",
	"泄漏",
	"锁死",
	"卡住",
	"闪退",
	"eperm",
	"eperm",
	"exit",
	"timeout",
	"error",
	"fail",
	"crash",
	"hang"
];
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
function symptomOverlap(query, text) {
	const lower = text.toLowerCase();
	let matched = 0;
	let present = 0;
	for (const marker of SYMPTOM_MARKERS) {
		if (!query.toLowerCase().includes(marker)) continue;
		present += 1;
		if (lower.includes(marker)) matched += 1;
	}
	return present === 0 ? 0 : matched / present;
}
/**
* Classify an outcome by composite score sign. A zero composite score (for
* example the neutral 5/5/5 extraction, or a gain that exactly cancels its
* cost) carries no net signal and must not be counted as a failure.
* @param utility - the outcome utility.
* @returns the polarity.
*/
function outcomePolarity(utility) {
	const score = utilityScore(utility);
	if (score > 0) return "positive";
	if (score < 0) return "negative";
	return "neutral";
}
/** FNV-1a 32-bit hash, a stable deterministic token hash.
* @param token - the token to hash.
* @returns an unsigned 32-bit hash.
*/
function hashToken(token) {
	let hash = 2166136261;
	for (let index = 0; index < token.length; index += 1) {
		hash ^= token.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}
/** Whether one code point is a CJK unified ideograph. */
function isCjk(char) {
	const code = char.codePointAt(0) ?? 0;
	return code >= 19968 && code <= 40959;
}
/** Tokenize text: lowercase latin/digit runs plus each CJK char separately.
* @param text - the input text.
* @returns the token list.
*/
function tokenize(text) {
	const tokens = [];
	let latin = "";
	const flush = () => {
		if (latin.length > 0) {
			tokens.push(latin);
			latin = "";
		}
	};
	for (const char of text) if (isCjk(char)) {
		flush();
		tokens.push(char);
	} else if (/[a-zA-Z0-9]/.test(char)) latin += char.toLowerCase();
	else flush();
	flush();
	return tokens;
}
/** Build an L2-normalized count bag over hashed tokens of one dimension. */
function bagVector(tokens, dim) {
	const counts = new Array(dim).fill(0);
	for (const token of tokens) {
		const slot = hashToken(token) % dim;
		counts[slot] = (counts[slot] ?? 0) + 1;
	}
	return normalize(counts);
}
/** L2-normalize a vector; a zero vector stays zero.
* @param vector - the input vector.
* @returns a normalized copy.
*/
function normalize(vector) {
	let norm = 0;
	for (const value of vector) norm += value * value;
	norm = Math.sqrt(norm);
	if (norm < 1e-9) return vector.slice();
	return vector.map((value) => value / norm);
}
/** Cosine similarity between two vectors; a zero-norm pair scores 0.
* @param a - the first vector.
* @param b - the second vector.
* @returns the cosine in [-1, 1].
*/
function cosine(a, b) {
	if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
	let dot = 0;
	let aNorm = 0;
	let bNorm = 0;
	for (let index = 0; index < a.length; index += 1) {
		const av = a[index] ?? 0;
		const bv = b[index] ?? 0;
		dot += av * bv;
		aNorm += av * av;
		bNorm += bv * bv;
	}
	const norm = Math.sqrt(aNorm) * Math.sqrt(bNorm);
	return norm < 1e-9 ? 0 : dot / norm;
}
/** Build the action retrieval vector from action text plus keywords.
* @param action - the action text.
* @param keywords - SAR-extracted action keywords.
* @returns a normalized ACTION_VECTOR_DIM vector.
*/
function actionVector(action, keywords) {
	return bagVector([...tokenize(action), ...keywords.map((keyword) => keyword.toLowerCase())], 384);
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
function outcomeVector(utility, outcomeText) {
	const vector = new Array(512).fill(0);
	vector[0] = (utility.materialGain - UTILITY_SCALE) / UTILITY_SCALE * UTILITY_WEIGHT;
	vector[1] = (utility.emotionalValence - UTILITY_SCALE) / UTILITY_SCALE * UTILITY_WEIGHT;
	vector[2] = -(utility.energyCost - UTILITY_SCALE) / UTILITY_SCALE * UTILITY_WEIGHT;
	const features = bagVector(tokenize(outcomeText), 509);
	for (let index = 3; index < 512; index += 1) vector[index] = features[index - 3] ?? 0;
	return normalize(vector);
}
/** Stable signature hash for one action text (temp-strategy keys).
* @param action - the action text.
* @returns the FNV hash value.
*/
function signatureHash(action) {
	return hashToken(action.toLowerCase());
}
//#endregion
export { actionVector as a, isPositiveOutcome as c, outcomeVector as d, signatureHash as f, utilityScore as h, UTILITY_SLOTS as i, normalize as l, tokenize as m, OUTCOME_VECTOR_DIM as n, cosine as o, symptomOverlap as p, SYMPTOM_MARKERS as r, hashToken as s, ACTION_VECTOR_DIM as t, outcomePolarity as u };
