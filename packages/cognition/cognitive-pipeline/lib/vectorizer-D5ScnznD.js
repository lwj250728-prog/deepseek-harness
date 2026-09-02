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
/** Signed composite utility of an outcome: gains and valence minus cost. */
function utilityScore(utility) {
	return utility.materialGain - UTILITY_SCALE + (utility.emotionalValence - UTILITY_SCALE) - (utility.energyCost - UTILITY_SCALE);
}
/** Whether an outcome counts as a positive hit for the frequency prior. */
function isPositiveOutcome(utility) {
	return utilityScore(utility) > 0;
}
/** FNV-1a 32-bit hash, a stable deterministic token hash. */
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
/** Tokenize text: lowercase latin/digit runs plus each CJK char separately. */
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
/** L2-normalize a vector; a zero vector stays zero. */
function normalize(vector) {
	let norm = 0;
	for (const value of vector) norm += value * value;
	norm = Math.sqrt(norm);
	if (norm < 1e-9) return vector.slice();
	return vector.map((value) => value / norm);
}
/** Cosine similarity between two vectors; a zero-norm pair scores 0. */
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
/** Build the action retrieval vector from action text plus keywords. */
function actionVector(action, keywords) {
	return bagVector([...tokenize(action), ...keywords.map((keyword) => keyword.toLowerCase())], 384);
}
/**
* Build the outcome clustering vector: three signed utility slots dominate the
* head (weighted before normalization), and hashed outcome-text features fill
* the tail. Clustering therefore groups by result *utility pattern*, not by
* outcome wording.
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
/** Stable signature hash for one action text (temp-strategy keys). */
function signatureHash(action) {
	return hashToken(action.toLowerCase());
}
//#endregion
export { cosine as a, normalize as c, tokenize as d, utilityScore as f, actionVector as i, outcomeVector as l, OUTCOME_VECTOR_DIM as n, hashToken as o, UTILITY_SLOTS as r, isPositiveOutcome as s, ACTION_VECTOR_DIM as t, signatureHash as u };
