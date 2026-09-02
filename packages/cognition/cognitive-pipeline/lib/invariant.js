import "./vectorizer-CLvOIhoX.js";
//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-cognitive-pipeline`.
* Verifies the store's probability, vector-dimension, and acceptance-ledger
* contracts whenever the pipeline service is mounted alongside the invariant
* registry.
* @module @deepseek-ai/dsh-cognitive-pipeline/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-cognitive-pipeline";
/** Cordis companion plugin name. */
const name = "cognitive-pipeline-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* Verify persisted contracts: probabilities stay in [0, 1] and stored vectors
* keep their declared dimensions. Runs once at install against the live
* snapshot; the check is intentionally cheap (no full rescan on every turn).
*/
const install = (ctx, fail) => {
	const service = ctx.get("cognitivePipeline");
	if (service === void 0) return;
	for (const prediction of service.store.predictionsSnapshot()) {
		if (!Number.isFinite(prediction.calibratedProbability) || prediction.calibratedProbability < 0 || prediction.calibratedProbability > 1) fail(`prediction ${prediction.predictionId} has calibratedProbability outside [0,1]`);
		if (prediction.confidenceLow < 0 || prediction.confidenceHigh > 1 || prediction.confidenceHigh < prediction.confidenceLow) fail(`prediction ${prediction.predictionId} has an invalid confidence interval`);
	}
	for (const exp of service.store.experiencesSnapshot()) {
		if (exp.actionVector.length !== 384) fail(`experience ${exp.expId} has actionVector of ${exp.actionVector.length} (expected 384)`);
		if (exp.outcomeVector.length !== 512) fail(`experience ${exp.expId} has outcomeVector of ${exp.outcomeVector.length} (expected 512)`);
		for (const sample of exp.settlements ?? []) {
			if (!Number.isFinite(sample.ts) || sample.ts < 0) fail(`experience ${exp.expId} has a settlement with an invalid timestamp`);
			if (!Number.isFinite(sample.quality) || sample.quality < 0 || sample.quality > 10) fail(`experience ${exp.expId} has a settlement quality outside [0,10]`);
		}
		const diseq = exp.disequilibrium;
		if (diseq !== void 0) {
			if (!Number.isFinite(diseq.atTs) || diseq.atTs < 0) fail(`experience ${exp.expId} has a disequilibrium with an invalid timestamp`);
			if (!Number.isFinite(diseq.sampleQuality) || diseq.sampleQuality < 0 || diseq.sampleQuality > 10) fail(`experience ${exp.expId} has a disequilibrium sample quality outside [0,10]`);
			if (!Number.isFinite(diseq.zScore) || diseq.zScore < 0) fail(`experience ${exp.expId} has a disequilibrium with an invalid z-score`);
		}
		if (exp.disequilibriumRecoveredAt !== void 0) {
			if (exp.disequilibrium === void 0) fail(`experience ${exp.expId} has a recovery timestamp without a disequilibrium event`);
			if (!Number.isFinite(exp.disequilibriumRecoveredAt) || exp.disequilibriumRecoveredAt < 0) fail(`experience ${exp.expId} has an invalid disequilibrium recovery timestamp`);
		}
	}
	for (const candidate of service.store.variantsSnapshot()) {
		if (candidate.verificationAnchor.length === 0) fail(`variant ${candidate.variantId} has an empty verification anchor`);
		if (![
			"proposed",
			"testing",
			"adopted",
			"rejected"
		].includes(candidate.status)) fail(`variant ${candidate.variantId} has an unknown status "${candidate.status}"`);
		for (const sample of candidate.settlements) {
			if (!Number.isFinite(sample.ts) || sample.ts < 0) fail(`variant ${candidate.variantId} has a settlement with an invalid timestamp`);
			if (!Number.isFinite(sample.quality) || sample.quality < 0 || sample.quality > 10) fail(`variant ${candidate.variantId} has a settlement quality outside [0,10]`);
		}
	}
	for (const cluster of service.store.clustersSnapshot()) if (!Array.isArray(cluster.situationCentroid) || cluster.situationCentroid.length !== 384) fail(`cluster ${cluster.clusterId} has situationCentroid of ${cluster.situationCentroid.length} (expected 384)`);
	for (const check of service.store.acceptanceSnapshot()) {
		if (!Number.isInteger(check.invokedCount) || check.invokedCount < 0 || !Number.isInteger(check.passedCount) || check.passedCount < 0 || !Number.isInteger(check.violatedCount) || check.violatedCount < 0) fail(`acceptance check ${check.checkId} has a negative or non-integer count`);
		if (check.passedCount + check.violatedCount > check.invokedCount) fail(`acceptance check ${check.checkId} has passed+violated exceeding invoked`);
		if (!Number.isInteger(check.machineVerifiedCount) || check.machineVerifiedCount < 0 || check.machineVerifiedCount > check.passedCount) fail(`acceptance check ${check.checkId} has an invalid machine-verified pass count`);
		if (check.cumulativeError < 0 || !Number.isInteger(check.errorFoldCount) || check.errorFoldCount < 0) fail(`acceptance check ${check.checkId} has an invalid error ledger`);
	}
	for (const audit of service.store.claimAuditsSnapshot()) {
		const violated = audit.violatedCheckIds.length > 0;
		if (audit.verdict === "violated" !== violated && audit.verdict !== "not-applicable") fail(`claim audit ${audit.auditId} has a verdict/check-list mismatch`);
		if (audit.anchorVerified !== (audit.anchor !== null && audit.anchor.matched)) fail(`claim audit ${audit.auditId} has an anchor-verification inconsistency`);
	}
};
/**
* Register this package's invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns the installed registration's disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
