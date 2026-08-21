/**
 * Model-facing tools over the cognitive pipeline: `remember_experience`,
 * `simulate_experience`, `reference_experience`, `predict_outcome`,
 * `report_outcome`, `rebuild_taxonomy`, `inspect_memory`, `register_loop`,
 * `define_acceptance_check`, `verify_claim`, and `update_acceptance_check`.
 * Every tool returns one canonical JSON value; `output.render` mirrors it into
 * model-facing text.
 * @module @deepseek-ai/dsh-cognitive-pipeline/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { findToolCallEvidence } from './log-evidence.ts'
import type { CognitivePipelineService } from './service.ts'
import type { PipelineCallContext } from './service.ts'
import type { PredictInput, RebuildResult } from './types.ts'

/** Build the model-call context from the executing agent's session. */
function callContext(exec: ToolRunContext): PipelineCallContext {
  return exec.agent === undefined ? {} : { sessionId: exec.agent.session.id }
}

/** One canonical text renderer shared by all tools. */
function renderJson(_args: unknown, value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** Register the eleven pipeline tools.
 * @param ctx - context with the tool registry.
 * @param service - the pipeline service backing the tools.
 */
export function registerPipelineTools(ctx: Context, service: CognitivePipelineService): void {
  ctx.tools.register(defineTool({
    name: 'remember_experience',
    description: 'Encode one raw experience (a past situation, the action taken, and its outcome) into the '
      + 'cognitive pipeline SAR memory. The pipeline extracts situation/action/outcome, scores the outcome '
      + 'utility (material gain, emotional valence, energy cost 0-10), and vectorizes both the action and the '
      + 'outcome for later retrieval and utility-space clustering. Call this when the user shares a completed '
      + 'experience that should inform future predictions.',
    parameters: {
      raw_text: {
        type: 'string',
        required: true,
        description: 'The raw experience text describing situation, action, and result.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exp_id: { type: 'string', required: true },
          situation: { type: 'string', required: true },
          action: { type: 'string', required: true },
          outcome: { type: 'string', required: true },
          outcome_utility: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              material_gain: { type: 'number', required: true },
              emotional_valence: { type: 'number', required: true },
              energy_cost: { type: 'number', required: true },
            },
          },
        },
      },
      render: renderJson,
    },
    async execute(args, exec) {
      const { expId, sar } = await service.remember({ rawText: args.raw_text }, {
        ...callContext(exec),
        signal: exec.signal,
      })
      return {
        exp_id: expId,
        situation: sar.situation,
        action: sar.action,
        outcome: sar.outcome,
        outcome_utility: {
          material_gain: sar.outcomeUtility.materialGain,
          emotional_valence: sar.outcomeUtility.emotionalValence,
          energy_cost: sar.outcomeUtility.energyCost,
        },
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Remember experience', kind: 'other', rawInput: args.raw_text }),
  }))

  ctx.tools.register(defineTool({
    name: 'simulate_experience',
    description: 'Generate a simulated experience via the LLM route: given a hypothetical situation and a proposed '
      + 'action, produce a predicted outcome as a retrieval-only candidate. The simulation shapes no cluster until '
      + 'real feedback through report_outcome verifies it (a decisive single feedback fast-tracks, cumulative '
      + 'evidence upgrades, contradiction rolls back, and unverified simulations expire after the fallback TTL). '
      + 'Use this when real testing is costly or impossible and a reasoned projection would help prediction.',
    parameters: {
      situation: {
        type: 'string',
        required: true,
        description: 'The hypothetical situation to reason about.',
      },
      action: {
        type: 'string',
        required: true,
        description: 'The proposed action whose outcome is to be simulated.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exp_id: { type: 'string', required: true },
          situation: { type: 'string', required: true },
          action: { type: 'string', required: true },
          outcome: { type: 'string', required: true },
          simulated: { type: 'boolean', required: true },
        },
      },
      render: renderJson,
    },
    async execute(args, exec) {
      const { expId, sar } = await service.simulate({
        situation: args.situation,
        action: args.action,
      }, {
        ...callContext(exec),
        signal: exec.signal,
      })
      return {
        exp_id: expId,
        situation: sar.situation,
        action: sar.action,
        outcome: sar.outcome,
        simulated: true,
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Simulate experience', kind: 'other', rawInput: args.action }),
  }))

  ctx.tools.register(defineTool({
    name: 'reference_experience',
    description: 'Derive a reference experience from the commonalities of similar history (cold-start online '
      + 'generalization): given the current situation and proposed action, retrieve the most similar past '
      + 'experiences, ask the LLM route to extract their shared pattern, and write it as a retrieval-only '
      + 'simulated candidate. It shapes no cluster until real feedback through report_outcome verifies it (the '
      + 'same evidence-replacement lifecycle as simulate_experience). Use this when the store has only a few '
      + 'similar experiences and a generalized "how these situations usually resolve" reference would help '
      + 'prediction.',
    parameters: {
      situation: {
        type: 'string',
        required: true,
        description: 'The current situation to anchor the reference derivation.',
      },
      action: {
        type: 'string',
        required: true,
        description: 'The proposed action whose similar-history pattern to generalize.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exp_id: { type: 'string', required: true },
          situation: { type: 'string', required: true },
          action: { type: 'string', required: true },
          outcome: { type: 'string', required: true },
          simulated: { type: 'boolean', required: true },
        },
      },
      render: renderJson,
    },
    async execute(args, exec) {
      const result = await service.deriveReference({
        situation: args.situation,
        action: args.action,
      }, {
        ...callContext(exec),
        signal: exec.signal,
      })
      if (result === null) {
        throw new Error('reference_experience: no common pattern derivable from similar history')
      }
      return {
        exp_id: result.expId,
        situation: result.sar.situation,
        action: result.sar.action,
        outcome: result.sar.outcome,
        simulated: true,
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Derive reference experience', kind: 'other', rawInput: args.action }),
  }))

  ctx.tools.register(defineTool({
    name: 'predict_outcome',
    description: 'Hot-loop prediction: given a situation and a proposed action, retrieve similar past actions, '
      + 'detect distribution shift (OOD), and produce a calibrated success probability with an 80% confidence '
      + 'interval. Novel actions trigger a scratchpad trial strategy instead of reusing old categories. When the '
      + 'situation matches a proven success cluster, success_reference returns that strategy to reuse. The '
      + 'returned prediction_id must be reported back through report_outcome once the actual result is known '
      + 'so the pipeline can learn from the error.',
    parameters: {
      situation: {
        type: 'string',
        required: true,
        description: 'The current situation context.',
      },
      action: {
        type: 'string',
        required: true,
        description: 'The proposed action to predict the outcome of.',
      },
      context: {
        type: 'string',
        description: 'Optional extra context folded into the calibration prompt.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prediction_id: { type: 'string', required: true },
          advice: { type: 'string', required: true },
          raw_probability: { type: 'number', required: true },
          calibrated_probability: { type: 'number', required: true },
          confidence_interval_low: { type: 'number', required: true },
          confidence_interval_high: { type: 'number', required: true },
          is_novel: { type: 'boolean', required: true },
          ood_signal: {
            type: 'string',
            required: true,
            enum: ['none', 'low-similarity', 'flat-top', 'high-strangeness'],
          },
          top_hit_count: { type: 'number', required: true },
          used_temp_strategy: { type: 'boolean', required: true },
          cluster_id: {
            required: true,
            oneOf: [{ type: 'number' }, { type: 'null' }],
          },
          success_reference: {
            required: true,
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  cluster_id: { type: 'number', required: true },
                  cluster_name: { type: 'string', required: true },
                  decision_rule: { type: 'string', required: true },
                  utility_range: {
                    type: 'object',
                    additionalProperties: false,
                    required: true,
                    properties: {
                      low: { type: 'number', required: true },
                      high: { type: 'number', required: true },
                    },
                  },
                },
              },
              { type: 'null' },
            ],
          },
          taxonomy_context: {
            required: true,
            type: 'object',
            additionalProperties: false,
            properties: {
              coverage: {
                type: 'string',
                required: true,
                enum: ['covered', 'gap', 'no-taxonomy'],
              },
              similarity: { type: 'number', required: true },
              margin: { type: 'number', required: true },
              cluster: {
                required: true,
                oneOf: [
                  {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      cluster_id: { type: 'number', required: true },
                      name: { type: 'string', required: true },
                      decision_rule: { type: 'string', required: true },
                      polarity: { type: 'string', required: true, enum: ['success', 'risk'] },
                    },
                  },
                  { type: 'null' },
                ],
              },
            },
          },
        },
      },
      render: renderJson,
    },
    async execute(args, exec) {
      const input: PredictInput = {
        situation: args.situation,
        action: args.action,
        ...args.context === undefined || args.context.length === 0 ? {} : { context: args.context },
      }
      const result = await service.predict(input, {
        ...callContext(exec),
        signal: exec.signal,
      })
      return {
        prediction_id: result.predictionId,
        advice: result.advice,
        raw_probability: result.rawProbability,
        calibrated_probability: result.calibratedProbability,
        confidence_interval_low: result.confidenceLow,
        confidence_interval_high: result.confidenceHigh,
        is_novel: result.isNovel,
        ood_signal: result.oodSignal,
        top_hit_count: result.topHitCount,
        used_temp_strategy: result.usedTempStrategy,
        cluster_id: result.clusterId,
        success_reference: result.successReference === null ? null : {
          cluster_id: result.successReference.clusterId,
          cluster_name: result.successReference.clusterName,
          decision_rule: result.successReference.decisionRule,
          utility_range: { ...result.successReference.utilityRange },
        },
        taxonomy_context: {
          coverage: result.taxonomyContext.coverage,
          similarity: result.taxonomyContext.similarity,
          margin: result.taxonomyContext.margin,
          cluster: result.taxonomyContext.cluster === null ? null : {
            cluster_id: result.taxonomyContext.cluster.clusterId,
            name: result.taxonomyContext.cluster.name,
            decision_rule: result.taxonomyContext.cluster.decisionRule,
            polarity: result.taxonomyContext.cluster.polarity,
          },
        },
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Predict outcome', kind: 'other', rawInput: args.action }),
  }))

  ctx.tools.register(defineTool({
    name: 'report_outcome',
    description: 'Feedback callback: report the actual outcome of a previous predict_outcome call. The pipeline '
      + 'computes the prediction error, updates lifetime calibration statistics, feeds the scratchpad when a '
      + 'trial strategy was used, and triggers an emergency local taxonomy repair when the error is extreme. '
      + 'outcome_quality (0-10) is required so every resolved prediction carries a real utility signal; a '
      + 'neutral baseline is never inferred from the outcome text.',
    parameters: {
      prediction_id: {
        type: 'string',
        required: true,
        description: 'The prediction_id returned by predict_outcome.',
      },
      actual_outcome: {
        type: 'string',
        required: true,
        description: 'The observed result text.',
      },
      outcome_quality: {
        type: 'number',
        required: true,
        description: 'Actual outcome quality 0-10 (5 = neutral). Required for a real utility signal.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, enum: ['logged'] },
          prediction_error: { type: 'number', required: true },
          trigger_rebuild: { type: 'boolean', required: true },
          rebuild_reason: {
            required: true,
            oneOf: [{ type: 'string' }, { type: 'null' }],
          },
        },
      },
      render: renderJson,
    },
    async execute(args, exec) {
      const result = await service.report({
        predictionId: args.prediction_id,
        actualOutcome: args.actual_outcome,
        outcomeQuality: args.outcome_quality,
      }, {
        ...callContext(exec),
        signal: exec.signal,
      })
      return {
        status: result.status,
        prediction_error: result.predictionError,
        trigger_rebuild: result.triggerRebuild,
        rebuild_reason: result.rebuildReason,
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Report outcome', kind: 'other', rawInput: args.prediction_id }),
  }))

  ctx.tools.register(defineTool({
    name: 'rebuild_taxonomy',
    description: 'Cold-loop taxonomy rebuild: sample decay-weighted high-error experiences, re-cluster them in '
      + 'utility space, anchor new clusters with evidence (≥3 distinct experience ids, backend-verified), '
      + 'backtest the proposal on the newest slice, and write it back only when it cuts validation error by at '
      + 'least 15%. Use scope "global" for a full rebuild or "local" to repair only the worst cluster. The '
      + 'resulting taxonomy summary is injected into the session system prompt.',
    parameters: {
      scope: {
        type: 'string',
        enum: ['local', 'global'],
        description: 'Rebuild scope; default global.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scope: { type: 'string', required: true, enum: ['local', 'global'] },
          accepted: { type: 'boolean', required: true },
          deferred: { type: 'boolean', required: true },
          old_error: {
            required: true,
            oneOf: [{ type: 'number' }, { type: 'null' }],
          },
          new_error: {
            required: true,
            oneOf: [{ type: 'number' }, { type: 'null' }],
          },
          delta_error: {
            required: true,
            oneOf: [{ type: 'number' }, { type: 'null' }],
          },
          cluster_count: { type: 'number', required: true },
          rejected_clusters: { type: 'number', required: true },
          sample_count: { type: 'number', required: true },
          reason: { type: 'string', required: true },
          taxonomy_version: { type: 'number', required: true },
        },
      },
      render: renderJson,
    },
    async execute(args, exec) {
      const result: RebuildResult = await service.rebuild(args.scope ?? 'global', {
        ...callContext(exec),
        signal: exec.signal,
      })
      return {
        scope: result.scope,
        accepted: result.accepted,
        deferred: result.deferred,
        old_error: result.oldError,
        new_error: result.newError,
        delta_error: result.deltaError,
        cluster_count: result.clusterCount,
        rejected_clusters: result.rejectedClusters,
        sample_count: result.sampleCount,
        reason: result.reason,
        taxonomy_version: result.taxonomyVersion,
      }
    },
    presentCall: args => ({ card: 'generic', title: `Rebuild taxonomy (${args.scope ?? 'global'})`, kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'inspect_memory',
    description: 'Read the cognitive pipeline state: stored experience and prediction counts, clusters, '
      + 'calibration buckets, active scratchpad strategies, the current taxonomy summary, and the most recent '
      + 'resolved predictions. Use it to understand what the pipeline has learned and how calibrated it is.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          experience_count: { type: 'number', required: true },
          prediction_count: { type: 'number', required: true },
          resolved_prediction_count: { type: 'number', required: true },
          cluster_count: { type: 'number', required: true },
          active_temp_strategy_count: { type: 'number', required: true },
          channel_weights: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              semantic: { type: 'number', required: true },
              situational: { type: 'number', required: true },
              symptom: { type: 'number', required: true },
              outcome: { type: 'number', required: true },
            },
          },
          taxonomy: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              version: { type: 'number', required: true },
              summary_short: { type: 'string', required: true },
              updated_at: { type: 'number', required: true },
            },
          },
          exploration: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              budget: { type: 'number', required: true },
              used: { type: 'number', required: true },
              total: { type: 'number', required: true },
              graduated: { type: 'number', required: true },
              expired: { type: 'number', required: true },
              validated: { type: 'number', required: true },
              refuted: { type: 'number', required: true },
              // -1 when no measured reuse exists yet (the average is undefined).
              avg_validation_error: { type: 'number', required: true },
              tasks: {
                type: 'object',
                additionalProperties: false,
                required: true,
                properties: {
                  pending: { type: 'number', required: true },
                  running: { type: 'number', required: true },
                  completed: { type: 'number', required: true },
                  failed: { type: 'number', required: true },
                },
              },
            },
          },
          loops: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                description: { type: 'string', required: true },
                prediction_count: { type: 'number', required: true },
                resolved_count: { type: 'number', required: true },
                avg_prediction_error: { type: 'number', required: true },
                executed_count: { type: 'number', required: true },
                refused_count: { type: 'number', required: true },
                failed_count: { type: 'number', required: true },
              },
            },
          },
          loop_executions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                receipt_id: { type: 'string', required: true },
                loop_name: { type: 'string', required: true },
                target: { type: 'string', required: true },
                decision: { type: 'string', required: true },
                rejected: { type: 'boolean', required: true },
                reason: { type: 'string', required: true },
                status: { type: 'string', required: true },
                outcome_quality: { type: 'number', required: true },
              },
            },
          },
          acceptance: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              check_count: { type: 'number', required: true },
              active_count: { type: 'number', required: true },
              retired_count: { type: 'number', required: true },
              invoked_count: { type: 'number', required: true },
              passed_count: { type: 'number', required: true },
              violated_count: { type: 'number', required: true },
              // -1 when nothing was invoked yet (the deviation rate is undefined).
              deviation_rate: { type: 'number', required: true },
              rework_check_ids: {
                type: 'array',
                required: true,
                items: { type: 'string' },
              },
            },
          },
          recent_audits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                audit_id: { type: 'string', required: true },
                claim: { type: 'string', required: true },
                verdict: {
                  type: 'string',
                  required: true,
                  enum: ['verified', 'violated', 'not-applicable'],
                },
                rework_needed: { type: 'boolean', required: true },
                deviation_exp_id: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: renderJson,
    },
    execute(_args, _exec) {
      const result = service.inspect()
      return Promise.resolve({
        experience_count: result.experienceCount,
        prediction_count: result.predictionCount,
        resolved_prediction_count: result.resolvedPredictionCount,
        cluster_count: result.clusterCount,
        active_temp_strategy_count: result.activeTempStrategyCount,
        channel_weights: {
          semantic: result.channelWeights.semantic,
          situational: result.channelWeights.situational,
          symptom: result.channelWeights.symptom,
          outcome: result.channelWeights.outcome,
        },
        taxonomy: {
          version: result.taxonomy.version,
          summary_short: result.taxonomy.summaryShort,
          updated_at: result.taxonomy.updatedAt,
        },
        exploration: {
          budget: result.exploration.budget,
          used: result.exploration.used,
          total: result.exploration.total,
          graduated: result.exploration.graduated,
          expired: result.exploration.expired,
          validated: result.exploration.validated,
          refuted: result.exploration.refuted,
          avg_validation_error: result.exploration.avgValidationError === null
            ? -1
            : Number(result.exploration.avgValidationError.toFixed(3)),
          tasks: {
            pending: result.exploration.tasks.pending,
            running: result.exploration.tasks.running,
            completed: result.exploration.tasks.completed,
            failed: result.exploration.tasks.failed,
          },
        },
        loops: result.loops.map(loop => ({
          name: loop.name,
          description: loop.description,
          prediction_count: loop.predictionCount,
          resolved_count: loop.resolvedCount,
          avg_prediction_error: loop.avgPredictionError === null
            ? -1
            : Number(loop.avgPredictionError.toFixed(3)),
          executed_count: loop.executedCount,
          refused_count: loop.refusedCount,
          failed_count: loop.failedCount,
        })),
        loop_executions: result.loopExecutions.map(receipt => ({
          receipt_id: receipt.receiptId,
          loop_name: receipt.loopName,
          target: receipt.target,
          decision: receipt.decision,
          rejected: receipt.rejected,
          reason: receipt.reason ?? '',
          status: receipt.status ?? 'submitted',
          outcome_quality: receipt.outcomeQuality ?? -1,
        })),
        acceptance: {
          check_count: result.acceptance.checkCount,
          active_count: result.acceptance.activeCount,
          retired_count: result.acceptance.retiredCount,
          invoked_count: result.acceptance.invokedCount,
          passed_count: result.acceptance.passedCount,
          violated_count: result.acceptance.violatedCount,
          deviation_rate: result.acceptance.deviationRate === null
            ? -1
            : Number(result.acceptance.deviationRate.toFixed(3)),
          rework_check_ids: [...result.acceptance.reworkCheckIds],
        },
        recent_audits: result.recentAudits.map(audit => ({
          audit_id: audit.auditId,
          claim: audit.claim,
          verdict: audit.verdict,
          rework_needed: audit.reworkNeeded,
          deviation_exp_id: audit.deviationExpId ?? '',
        })),
      })
    },
    presentCall: () => ({ card: 'generic', title: 'Inspect cognitive memory', kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'register_loop',
    description: 'Register a named meta-cognition loop (造新环路): a special-experience layer whose decisions '
      + 'flow through the SAME predict/report calibration ruler as every other prediction. Registering a loop '
      + 'gives it a stable identity — its decision history is retrievable under a `loop:<name>` prefix and '
      + 'aggregated per-loop in inspect_memory. Use this to make a new recurring decision (e.g. "when to '
      + 'compact", "when to retry", "when to ask the user") learnable instead of hard-coded: register once, then '
      + 'drive it with predict_outcome/report_outcome on `loop:<name> 情境=…` situations.',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'Stable loop identity, lowercase with hyphens (e.g. "when-to-compact").',
      },
      description: {
        type: 'string',
        required: true,
        description: 'One line describing what this loop decides.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          registered: { type: 'boolean', required: true },
        },
      },
      render: renderJson,
    },
    execute(args) {
      service.registerLoop({ name: args.name, description: args.description })
      return Promise.resolve({ name: args.name, registered: true })
    },
    presentCall: args => ({ card: 'generic', title: `Register cognitive loop ${args.name}`, kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'define_acceptance_check',
    description: 'Define one acceptance criterion: a reusable verification norm the agent audits claims against '
      + 'before treating them as settled, e.g. "claims of completion must cite evidence". The pipeline records '
      + 'evidence PRESENCE, never evidence truth — it cannot verify its own claims; truth is adjudicated by the '
      + 'resolved outcome and the user. The criterion is active immediately with an empty evidence ledger; its '
      + 'track record (invoked/passed/violated/error) can never be reset.',
    parameters: {
      criterion: {
        type: 'string',
        required: true,
        description: 'The norm as a testable statement, e.g. "声称完成前必须给出证据来源".',
      },
      trigger: {
        type: 'string',
        required: true,
        description: 'Situation marker selecting this check: an audit applies it when the marker appears in the '
          + 'claim or its situation text.',
      },
      evidence_hint: {
        type: 'string',
        required: true,
        description: 'What evidence a claim must carry to satisfy the criterion.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          check_id: { type: 'string', required: true },
          criterion: { type: 'string', required: true },
          trigger: { type: 'string', required: true },
          evidence_hint: { type: 'string', required: true },
          revision: { type: 'number', required: true },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      const check = await service.defineAcceptanceCheck({
        criterion: args.criterion,
        trigger: args.trigger,
        evidenceHint: args.evidence_hint,
      })
      return {
        check_id: check.checkId,
        criterion: check.criterion,
        trigger: check.trigger,
        evidence_hint: check.evidenceHint,
        revision: check.revision,
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Define acceptance check', kind: 'other', rawInput: args.criterion }),
  }))

  ctx.tools.register(defineTool({
    name: 'verify_claim',
    description: 'Audit one claim against the active acceptance criteria before treating it as settled. '
      + 'Applicable checks are those whose trigger marker appears in the claim or its situation; a claim with '
      + 'no applicable check audits as not-applicable. An applicable check is satisfied when the claim carries '
      + 'evidence (non-empty), violated when it does not — presence, not truth. When log_anchor is supplied, '
      + 'the session ledger decides instead: the tool reads the executing session\'s log for the most recent '
      + 'tool/call of that name and checks whether its tool/result matched the expectation — a missing or '
      + 'mismatched anchor violates the claim regardless of self-reported evidence (the log is the witness, so '
      + 'a claim anchored to the ledger cannot be validated by self-report alone). Violated checks accumulate '
      + 'in the criterion ledger, and a criterion whose invoked count clears the evidence minimum while its '
      + 'deviation rate crosses the threshold flags rework_needed and records one deviation meta experience. '
      + 'Pass prediction_id when a predict_outcome exists for the claim: its report_outcome feedback then folds '
      + 'the prediction error into the violated criteria, measuring "claims without verification" on the same '
      + 'ruler as every prediction.',
    parameters: {
      claim: {
        type: 'string',
        required: true,
        description: 'The claim being made, e.g. "管线已学会验收标准".',
      },
      situation: {
        type: 'string',
        required: true,
        description: 'The context the claim is made in.',
      },
      evidence: {
        type: 'string',
        description: 'The verification statement backing the claim; omit or leave empty when the claim is '
          + 'made without evidence.',
      },
      prediction_id: {
        type: 'string',
        description: 'Optional prediction_id from predict_outcome that this claim is about; its feedback '
          + 'folds into violated criteria.',
      },
      log_anchor: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tool_name: {
            type: 'string',
            required: true,
            description: 'The tool name whose most recent call in this session\'s ledger is the witness.',
          },
          expect_succeeded: {
            type: 'boolean',
            required: true,
            description: 'Whether the claim asserts the call succeeded (true) or failed (false).',
          },
        },
        description: 'Anchor the claim to the session ledger: the ledger\'s tool/result mechanically decides '
          + 'the audit instead of self-reported evidence. Set it when the verification is a tool call that '
          + 'happened in this session.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          audit_id: { type: 'string', required: true },
          verdict: {
            type: 'string',
            required: true,
            enum: ['verified', 'violated', 'not-applicable'],
          },
          applied_check_ids: {
            type: 'array',
            required: true,
            items: { type: 'string' },
          },
          satisfied_check_ids: {
            type: 'array',
            required: true,
            items: { type: 'string' },
          },
          violated_check_ids: {
            type: 'array',
            required: true,
            items: { type: 'string' },
          },
          log_verified: {
            type: 'boolean',
            required: true,
            description: 'True when the audit was backed by a matched session-log anchor (the '
              + 'non-self-referential witness), false for self-reported evidence or no anchor.',
          },
          rework_needed: { type: 'boolean', required: true },
          deviation_exp_id: { type: 'string', required: true },
        },
      },
      render: renderJson,
    },
    async execute(args, exec) {
      let logEvidence: {
        toolName: string
        callId: string
        expectedSucceeded: boolean
        matched: boolean
      } | null = null
      if (args.log_anchor !== undefined && exec.agent !== undefined) {
        const evidence = findToolCallEvidence(exec.agent.session, args.log_anchor.tool_name)
        logEvidence = {
          toolName: args.log_anchor.tool_name,
          callId: evidence?.callId ?? '',
          expectedSucceeded: args.log_anchor.expect_succeeded,
          matched: evidence !== null && evidence.succeeded === args.log_anchor.expect_succeeded,
        }
      }
      const audit = await service.auditClaim({
        claim: args.claim,
        situation: args.situation,
        ...args.evidence === undefined || args.evidence.length === 0 ? {} : { evidence: args.evidence },
        ...args.prediction_id === undefined || args.prediction_id.length === 0 ? {} : { predictionId: args.prediction_id },
        ...logEvidence === null ? {} : { logEvidence },
      })
      return {
        audit_id: audit.auditId,
        verdict: audit.verdict,
        applied_check_ids: [...audit.appliedCheckIds],
        satisfied_check_ids: [...audit.satisfiedCheckIds],
        violated_check_ids: [...audit.violatedCheckIds],
        log_verified: audit.logVerified,
        rework_needed: audit.reworkNeeded,
        deviation_exp_id: audit.deviationExpId ?? '',
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Verify claim', kind: 'other', rawInput: args.claim }),
  }))

  ctx.tools.register(defineTool({
    name: 'update_acceptance_check',
    description: 'Rewrite an active acceptance criterion\'s statement or evidence hint, or retire it. A retired '
      + 'criterion is frozen: its evidence ledger is never reset and audits no longer apply it — criteria are '
      + 'revisable, their track record is not (the evidence gate of acceptance-criterion change).',
    parameters: {
      check_id: {
        type: 'string',
        required: true,
        description: 'The acceptance criterion id from define_acceptance_check.',
      },
      criterion: {
        type: 'string',
        description: 'New criterion statement.',
      },
      evidence_hint: {
        type: 'string',
        description: 'New evidence hint.',
      },
      retire: {
        type: 'boolean',
        description: 'Set true to freeze the criterion as retired (terminal; cannot be un-retired).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          check_id: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: ['active', 'retired'] },
          criterion: { type: 'string', required: true },
          evidence_hint: { type: 'string', required: true },
          revision: { type: 'number', required: true },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      const check = await service.updateAcceptanceCheck({
        checkId: args.check_id,
        ...args.criterion === undefined || args.criterion.length === 0 ? {} : { criterion: args.criterion },
        ...args.evidence_hint === undefined || args.evidence_hint.length === 0 ? {} : { evidenceHint: args.evidence_hint },
        ...args.retire === undefined ? {} : { retire: args.retire },
      })
      return {
        check_id: check.checkId,
        status: check.status,
        criterion: check.criterion,
        evidence_hint: check.evidenceHint,
        revision: check.revision,
      }
    },
    presentCall: args => ({ card: 'generic', title: `Update acceptance check ${args.check_id}`, kind: 'other' }),
  }))
}
