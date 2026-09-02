/**
 * The derived cognition object abstraction: the special-experience layer
 * pattern that has recurred five times (clusters, meta-cognition loops,
 * acceptance criteria, trigger jumps, and now goal-anchored chains). A kind
 * DECLARES its lifecycle — project / persist / measure / reinforce / expose —
 * and the pipeline drives it generically, so a new derived object costs a
 * declaration instead of hand-rolled plumbing. The abstraction covers the
 * DECISION layer (lifecycle shape, the ruler, the evidence gate); execution
 * (per-kind storage, channel wiring, legacy normalization) stays per-kind,
 * per the exp_93 boundary lesson.
 * @module @deepseek-ai/dsh-cognitive-pipeline/cognition-objects
 */
import type { CognitiveStore } from './store.ts';
import type { ChainExperience, ChainPattern, Experience } from './types.ts';
import type { ResolvedCognitivePipelineConfig } from './service.ts';
/** The deployment-varying knobs a kind may read during projection. */
export type CognitionObjectConfig = Pick<ResolvedCognitivePipelineConfig, 'chainMinMembers' | 'chainPatternMinMembers'>;
/** The lifecycle a derived cognition object declares. */
export interface CognitionObjectKind<T> {
    /** Stable kind identity (e.g. `chain`). */
    readonly name: string;
    /** One line describing what this kind derives and measures. */
    readonly description: string;
    /** Project the store into a candidate build; the kind applies its evidence
     * gate. Synchronous kinds return the build directly; kinds with an LLM
     * step return a promise. */
    project(store: CognitiveStore, config: CognitionObjectConfig): readonly T[] | Promise<readonly T[]>;
    /** Persist a gated build, carrying identity + evidence. */
    persist(store: CognitiveStore, build: readonly T[]): void;
    /** Fold one piece of feedback into an object's measured ruler. */
    measure(store: CognitiveStore, objectId: string, feedback: unknown): void;
    /** Reinforce on rebuild: carry measured stats across the projection, apply gates. */
    reinforce(store: CognitiveStore, config: CognitionObjectConfig, build: readonly T[]): readonly T[];
    /** The current objects (the model-visible source). */
    current(store: CognitiveStore): readonly T[];
}
/** Assemble one goal-anchored chain from its tagged members: the causal
 * skeleton keeps failure steps and cross-agent delegation nodes as structural
 * steps, collapses routine successes into a bounded summary (memory organizes
 * around surprises), and carries the previous chain's measured citation stats.
 * @param chainId - the goal trace id.
 * @param goal - the goal anchoring the chain (the MOP goal).
 * @param anchorSessionId - the session that anchored the chain, when known.
 * @param members - the experiences tagged with this chainId (unordered).
 * @param previous - the previous chain for the same id, if any (stats carry).
 * @param now - the reference timestamp.
 * @returns the consolidated chain.
 */
export declare function assembleChain(chainId: string, goal: string, anchorSessionId: string | null, members: readonly Experience[], previous: ChainExperience | undefined, now: number): ChainExperience;
/**
 * The child chains of one chain: chains whose ROOT member derives from this
 * chain's delegation receipts (a delegated sub-goal's entry node references
 * the parent's receipt). Anchoring on the root breaks the cycle that a shared
 * receipt would otherwise create — the delegating chain's own mid-chain
 * receipt node is never a root, so it cannot appear as its own child.
 * @param chain - the parent chain.
 * @param experiences - the full experience snapshot.
 * @returns the distinct child chain ids.
 */
export declare function childChainIdsOf(chain: ChainExperience, experiences: readonly Experience[]): readonly string[];
/**
 * The chain kind: the first declarative instance of a derived cognition
 * object. It projects the goal-anchored causal skeletons from chain-tagged
 * experiences (evidence gate: `chainMinMembers`), persists them to
 * `chains.json`, measures them with the chain-level citation rate (an
 * injection of a chain is cited when the model references it), and exposes
 * them as structured step lists. Reinforcement carries the measured stats
 * across rebuilds; chains are goal-scoped, so no chain is pruned by the
 * object framework itself.
 */
export declare class ChainObjectKind implements CognitionObjectKind<ChainExperience> {
    readonly name = "chain";
    readonly description = "goal-anchored causal skeletons from chain-tagged experiences, measured by chain-level citation rate";
    project(store: CognitiveStore, config: CognitionObjectConfig): readonly ChainExperience[];
    persist(store: CognitiveStore, build: readonly ChainExperience[]): void;
    measure(store: CognitiveStore, objectId: string, feedback: unknown): void;
    reinforce(_store: CognitiveStore, _config: CognitionObjectConfig, build: readonly ChainExperience[]): readonly ChainExperience[];
    current(store: CognitiveStore): readonly ChainExperience[];
}
/** The structural signature of one chain: coarse goal domain + the step
 * polarity sequence + the causal-break-point axis (whether any member
 * self-reflexively killed the agent's own host), e.g. `发布:失败,失败,成功` or
 * `重启:失败~自反`. The self-reflexive axis is the cross-domain theme
 * projector: "self-reflexive interruption → external witnessing" recurs across
 * unrelated goal domains, so chains from different domains that both carry the
 * break point share a signature suffix and can aggregate into one theme.
 * @param chain - the chain to sign.
 * @returns the signature string.
 */
export declare function chainSignature(chain: ChainExperience): string;
/**
 * The chain-pattern kind: the sixth derived cognition object and the
 * abstraction's FIRST recursive consumer — patterns project from the chain
 * table the way chains project from experiences. Chains sharing a structural
 * signature (coarse goal domain + polarity sequence) aggregate into a
 * recurring goal-execution pattern (the TOPS analogue: from similar MOPs,
 * extract the cross-situation thematic pattern). Measured utility is
 * aggregated from the member chains' citation stats; the pattern's cited rate
 * retroactively measures whether the grouping was useful.
 */
export declare class ChainPatternObjectKind implements CognitionObjectKind<ChainPattern> {
    readonly name = "chain-pattern";
    readonly description = "recurring goal-execution patterns aggregated from chains (TOPS analogue), measured by member chain citation";
    project(store: CognitiveStore, config: CognitionObjectConfig): readonly ChainPattern[];
    persist(store: CognitiveStore, build: readonly ChainPattern[]): void;
    measure(store: CognitiveStore, objectId: string, _feedback: unknown): void;
    reinforce(_store: CognitiveStore, _config: CognitionObjectConfig, build: readonly ChainPattern[]): readonly ChainPattern[];
    current(store: CognitiveStore): readonly ChainPattern[];
}
//# sourceMappingURL=cognition-objects.d.ts.map