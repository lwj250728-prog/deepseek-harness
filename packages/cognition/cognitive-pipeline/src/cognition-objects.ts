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

import type { CognitiveStore } from './store.ts'
import type {
  ChainExperience,
  ChainPattern,
  ChainStatus,
  ChainStep,
  Experience,
} from './types.ts'
import { outcomePolarity, tokenize } from './vectorizer.ts'
import { STOP_WORDS } from './triggers.ts'
import type { ResolvedCognitivePipelineConfig } from './service.ts'

/** The deployment-varying knobs a kind may read during projection. */
export type CognitionObjectConfig = Pick<ResolvedCognitivePipelineConfig, 'chainMinMembers' | 'chainPatternMinMembers'>

/** The lifecycle a derived cognition object declares. */
export interface CognitionObjectKind<T> {
  /** Stable kind identity (e.g. `chain`). */
  readonly name: string
  /** One line describing what this kind derives and measures. */
  readonly description: string
  /** Project the store into a candidate build; the kind applies its evidence
   * gate. Synchronous kinds return the build directly; kinds with an LLM
   * step return a promise. */
  project(store: CognitiveStore, config: CognitionObjectConfig): readonly T[] | Promise<readonly T[]>
  /** Persist a gated build, carrying identity + evidence. */
  persist(store: CognitiveStore, build: readonly T[]): void
  /** Fold one piece of feedback into an object's measured ruler. */
  measure(store: CognitiveStore, objectId: string, feedback: unknown): void
  /** Reinforce on rebuild: carry measured stats across the projection, apply gates. */
  reinforce(store: CognitiveStore, config: CognitionObjectConfig, build: readonly T[]): readonly T[]
  /** The current objects (the model-visible source). */
  current(store: CognitiveStore): readonly T[]
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
export function assembleChain(
  chainId: string,
  goal: string,
  anchorSessionId: string | null,
  members: readonly Experience[],
  previous: ChainExperience | undefined,
  now: number,
): ChainExperience {
  const ordered = [...members].sort((a, b) =>
    (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER)
    || a.timestamp - b.timestamp)
  const steps: ChainStep[] = []
  const delegationIds: string[] = []
  const collapsed: string[] = []
  let sequence = 0
  for (const member of ordered) {
    const polarity = outcomePolarity(member.sar.outcomeUtility)
    const isDelegation = typeof member.parentNodeId === 'string' && member.parentNodeId.includes('@')
    if (polarity === 'negative' || isDelegation) {
      steps.push({
        nodeId: member.expId,
        text: `${member.sar.action}。${member.sar.outcome}`.slice(0, 200),
        polarity: polarity === 'negative' ? 'failure' : 'success',
        sequence,
      })
      sequence += 1
      if (isDelegation) delegationIds.push(member.parentNodeId)
    } else {
      collapsed.push(`${member.sar.action}。${member.sar.outcome}`)
    }
  }
  const memberExpIds = ordered.map(member => member.expId)
  // Carry the previous distilled principle only while the member set is
  // unchanged: a rebuild with the same atoms keeps its LLM-distilled rule
  // without a fresh (expensive) distillation call, and a changed member set
  // drops it so the caller re-distills from the new atoms (宁缺毋滥 — never
  // serve a stale principle against changed evidence).
  const memberSetChanged = previous !== undefined && (
    previous.memberExpIds.length !== memberExpIds.length
    || previous.memberExpIds.some((id, index) => id !== memberExpIds[index])
  )
  return {
    chainId,
    goal,
    anchorSessionId,
    status: 'consolidated' satisfies ChainStatus,
    steps,
    memberExpIds,
    delegationNodeIds: [...new Set(delegationIds)],
    childChainIds: [],
    collapsedCount: collapsed.length,
    summary: collapsed.slice(0, 4).join('；').slice(0, 500),
    ...previous !== undefined && !memberSetChanged && previous.distilledPrinciple !== undefined
      ? { distilledPrinciple: previous.distilledPrinciple }
      : {},
    ...ordered.some(member => member.selfReflexive === true) ? { selfReflexive: true } : {},
    hitCount: previous?.hitCount ?? 0,
    citedCount: previous?.citedCount ?? 0,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  }
}

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
export function childChainIdsOf(chain: ChainExperience, experiences: readonly Experience[]): readonly string[] {
  const receipts = new Set(chain.delegationNodeIds)
  if (receipts.size === 0) return []
  const roots = new Map<string, Experience>()
  for (const exp of experiences) {
    if (exp.chainId === undefined || exp.chainId === chain.chainId) continue
    const current = roots.get(exp.chainId)
    if (current === undefined
      || (exp.sequence ?? Number.MAX_SAFE_INTEGER) < (current.sequence ?? Number.MAX_SAFE_INTEGER)) {
      roots.set(exp.chainId, exp)
    }
  }
  const children = new Set<string>()
  for (const [chainId, root] of roots) {
    if (root.parentNodeId !== undefined && receipts.has(root.parentNodeId)) children.add(chainId)
  }
  return [...children]
}

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
export class ChainObjectKind implements CognitionObjectKind<ChainExperience> {
  readonly name = 'chain'
  readonly description = 'goal-anchored causal skeletons from chain-tagged experiences, measured by chain-level citation rate'

  project(store: CognitiveStore, config: CognitionObjectConfig): readonly ChainExperience[] {
    const byChain = new Map<string, Experience[]>()
    const experiences = store.experiencesSnapshot()
    for (const exp of experiences) {
      if (exp.chainId === undefined) continue
      const members = byChain.get(exp.chainId) ?? []
      members.push(exp)
      byChain.set(exp.chainId, members)
    }
    const now = Date.now()
    const chains: ChainExperience[] = []
    for (const [chainId, members] of byChain) {
      if (members.length < config.chainMinMembers) continue
      const previous = store.getChain(chainId)
      const first = members[0]
      const assembled = assembleChain(
        chainId,
        previous?.goal ?? (first === undefined ? chainId : first.sar.situation.slice(0, 80)),
        previous?.anchorSessionId ?? null,
        members,
        previous,
        now,
      )
      chains.push({ ...assembled, childChainIds: childChainIdsOf(assembled, experiences) })
    }
    return chains
  }

  persist(store: CognitiveStore, build: readonly ChainExperience[]): void {
    store.replaceChains(build)
  }

  measure(store: CognitiveStore, objectId: string, feedback: unknown): void {
    store.foldChainCitation(objectId, feedback === true)
  }

  reinforce(_store: CognitiveStore, _config: CognitionObjectConfig, build: readonly ChainExperience[]): readonly ChainExperience[] {
    // Stats are carried inside project (previous-chain lookup); chains are
    // goal-scoped, so the object framework prunes nothing here.
    return build
  }

  current(store: CognitiveStore): readonly ChainExperience[] {
    return store.chainsSnapshot()
  }
}

/** The coarse goal-domain key: the first non-stop character token of the goal. */
function goalDomainKey(goal: string): string {
  for (const token of tokenize(goal)) {
    if (!STOP_WORDS.has(token)) return token
  }
  return goal.slice(0, 4)
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
export function chainSignature(chain: ChainExperience): string {
  const polaritySeq = chain.steps.map(step => step.polarity === 'failure' ? '失败' : '成功').join(',')
  const suffix = chain.selfReflexive === true ? '~自反' : ''
  return `${goalDomainKey(chain.goal)}:${polaritySeq === '' ? '空' : polaritySeq}${suffix}`
}

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
export class ChainPatternObjectKind implements CognitionObjectKind<ChainPattern> {
  readonly name = 'chain-pattern'
  readonly description = 'recurring goal-execution patterns aggregated from chains (TOPS analogue), measured by member chain citation'

  project(store: CognitiveStore, config: CognitionObjectConfig): readonly ChainPattern[] {
    const bySignature = new Map<string, ChainExperience[]>()
    for (const chain of store.chainsSnapshot()) {
      const signature = chainSignature(chain)
      const group = bySignature.get(signature) ?? []
      group.push(chain)
      bySignature.set(signature, group)
    }
    const now = Date.now()
    const patterns: ChainPattern[] = []
    for (const [signature, group] of bySignature) {
      if (group.length < config.chainPatternMinMembers) continue
      const previous = store.getChainPattern(signature)
      // Skeleton = the union of member steps, deduped by text, bounded.
      const seen = new Set<string>()
      const skeleton: ChainStep[] = []
      for (const chain of group) {
        for (const step of chain.steps) {
          if (skeleton.length >= 6) break
          if (seen.has(step.text)) continue
          seen.add(step.text)
          skeleton.push(step)
        }
        if (skeleton.length >= 6) break
      }
      const goalCounts = new Map<string, number>()
      for (const chain of group) {
        const domain = chain.goal.slice(0, 20)
        goalCounts.set(domain, (goalCounts.get(domain) ?? 0) + 1)
      }
      const goalDomain = [...goalCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
      patterns.push({
        patternId: signature,
        signature,
        chainIds: group.map(chain => chain.chainId),
        skeleton,
        goalDomain,
        hitCount: group.reduce((sum, chain) => sum + chain.hitCount, 0),
        citedCount: group.reduce((sum, chain) => sum + chain.citedCount, 0),
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      })
    }
    return patterns
  }

  persist(store: CognitiveStore, build: readonly ChainPattern[]): void {
    store.replaceChainPatterns(build)
  }

  measure(store: CognitiveStore, objectId: string, _feedback: unknown): void {
    // The feedback subject is a member chain (settlement folds a chain
    // citation): recompute every pattern that aggregates it, so a pattern's
    // measured utility tracks its member chains' citation outcomes.
    for (const pattern of store.chainPatternsSnapshot()) {
      if (pattern.chainIds.includes(objectId)) store.recomputeChainPatternStats(pattern.patternId)
    }
  }

  reinforce(_store: CognitiveStore, _config: CognitionObjectConfig, build: readonly ChainPattern[]): readonly ChainPattern[] {
    return build
  }

  current(store: CognitiveStore): readonly ChainPattern[] {
    return store.chainPatternsSnapshot()
  }
}
