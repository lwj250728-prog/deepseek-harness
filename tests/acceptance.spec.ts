/**
 * Acceptance-criteria coverage: define/rewrite/retire criteria, deterministic
 * claim audits (evidence presence, not truth), the persistence round-trip of
 * `acceptance.json` + `claim_audits.jsonl`, the report-time feedback fold into
 * violated criteria, the deviation gate that records one meta experience
 * per threshold crossing, and log-anchored audits where the session ledger
 * mechanically decides instead of self-reported evidence.
 */

import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { CallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { findToolCallEvidence } from '../src/index.ts'
import { CognitiveStore } from '../src/store.ts'
import { executeTool, pipelineHarness, stubAgent } from './helpers.ts'

/** One canned shell outcome for the stub executor. */
function runResult(exitCode: number | null, extra: Partial<ShellRunResult> = {}): ShellRunResult {
  return {
    exitCode,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 30_000,
    stdout: { text: '', truncated: false },
    stderr: { text: '', truncated: false },
    ...extra,
  }
}

/** A scripted `ctx.shell` executor: resolves requests and serves canned results. */
class StubShell extends ShellExecutor {
  static results: readonly ShellRunResult[] = []

  resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      command: request.command,
      workdir: process.cwd(),
      timeoutMs: request.timeoutMs ?? 30_000,
      stdoutMaxBytes: 0,
      sandboxPolicy: undefined,
    }
  }

  async run(): Promise<ShellRunResult> {
    const next = StubShell.results[0]
    StubShell.results = StubShell.results.slice(1)
    return next ?? runResult(0)
  }

  start(): ShellProcess {
    throw new Error('stub shell does not start background processes')
  }
}

/** Seed a session ledger with a successful `pwsh` call and a failed `git` call. */
function seedLedger(session: Session): void {
  session.append('turn/start', { turn: 1 })
  session.append('tool/call', { turn: 1, step: 1, callId: CallId('call-1'), name: 'pwsh', arguments: '{}' })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId: CallId('call-1'), content: [{ type: 'text', text: 'ok' }], isError: false }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 2, callId: CallId('call-2'), name: 'git', arguments: '{}' })
  session.append('tool/result', {
    turn: 1,
    step: 2,
    message: createToolResultMessage({ callId: CallId('call-2'), content: [{ type: 'text', text: 'failed' }], isError: true }),
  }, { surfaceOp: 'append' })
}

/** A fresh session ledger with a successful `pwsh` call and a failed `git` call. */
function ledgerWithToolResults(): Session {
  const session = Session.create(SessionId('log-anchor-ledger'))
  seedLedger(session)
  return session
}

describe('acceptance criteria and claim audits', () => {
  it('defines criteria, audits claims deterministically, and persists both tables', async () => {
    const { ctx, root, teardown } = await pipelineHarness()
    try {
      const { agent } = stubAgent('acceptance-agent')
      ctx.agents.register(agent)

      const defined = await executeTool(ctx, 'define_acceptance_check', {
        criterion: '声称完成前必须给出证据来源',
        trigger: '声称完成',
        evidence_hint: '引用完成该工作的具体证据',
      }, agent) as Record<string, unknown>
      expect(defined.check_id).toBe('check_1')
      expect(defined.revision).toBe(1)

      // not-applicable: no active trigger appears in claim or situation.
      const notApplicable = await executeTool(ctx, 'verify_claim', {
        claim: '今天天气不错',
        situation: '闲聊',
      }, agent) as Record<string, unknown>
      expect(notApplicable.verdict).toBe('not-applicable')

      // violated: trigger appears, no evidence supplied.
      const violated = await executeTool(ctx, 'verify_claim', {
        claim: '管线已学会验收标准，声称完成',
        situation: '实现验收清单',
      }, agent) as Record<string, unknown>
      expect(violated.verdict).toBe('violated')
      expect(violated.applied_check_ids).toEqual(['check_1'])
      expect(violated.violated_check_ids).toEqual(['check_1'])
      expect(violated.rework_needed).toBe(false)

      // verified: trigger appears and the claim carries evidence.
      const verified = await executeTool(ctx, 'verify_claim', {
        claim: '已完成验收清单实现，声称完成',
        situation: '实现验收清单',
        evidence: '类型检查与包内测试通过，inspect 暴露验收统计',
      }, agent) as Record<string, unknown>
      expect(verified.verdict).toBe('verified')
      expect(verified.satisfied_check_ids).toEqual(['check_1'])

      const inspected = await executeTool(ctx, 'inspect_memory', {}, agent) as Record<string, unknown>
      const acceptance = inspected.acceptance as Record<string, unknown>
      expect(acceptance.check_count).toBe(1)
      expect(acceptance.active_count).toBe(1)
      expect(acceptance.invoked_count).toBe(2)
      expect(acceptance.passed_count).toBe(1)
      expect(acceptance.violated_count).toBe(1)
      const audits = inspected.recent_audits as { audit_id: string; verdict: string }[]
      expect(audits.map(audit => audit.verdict)).toEqual(['verified', 'violated', 'not-applicable'])

      // Persistence round-trip through the same files the service wrote.
      const store = new CognitiveStore(root)
      await store.load()
      expect(store.acceptanceSnapshot().length).toBe(1)
      expect(store.claimAuditsSnapshot().length).toBe(3)
      const check = store.acceptanceSnapshot()[0]!
      expect(check.invokedCount).toBe(2)
      expect(check.passedCount).toBe(1)
      expect(check.violatedCount).toBe(1)
    } finally {
      await teardown()
    }
  })

  it('folds prediction error into violated criteria on report (验收回流)', async () => {
    const { ctx, teardown } = await pipelineHarness()
    try {
      const { agent } = stubAgent('acceptance-feedback-agent')
      ctx.agents.register(agent)
      await ctx.cognitivePipeline.defineAcceptanceCheck({
        criterion: '声称完成前必须给出证据来源',
        trigger: '声称完成',
        evidenceHint: '引用具体证据',
      })
      const pred = await ctx.cognitivePipeline.predict({ situation: '实现验收清单', action: '声称完成' })
      const audit = await ctx.cognitivePipeline.auditClaim({
        claim: '验收清单已实现，声称完成',
        situation: '实现验收清单',
        predictionId: pred.predictionId,
      })
      expect(audit.verdict).toBe('violated')
      await ctx.cognitivePipeline.report({
        predictionId: pred.predictionId,
        actualOutcome: '实际未通过验收',
        outcomeQuality: 3,
      })
      const check = ctx.cognitivePipeline.store.getAcceptanceCheck('check_1')!
      const error = Math.abs(pred.calibratedProbability - 0.3)
      expect(check.cumulativeError).toBeCloseTo(error, 5)
      expect(check.errorFoldCount).toBe(1)
    } finally {
      await teardown()
    }
  })

  it('flags rework once per threshold crossing and records one deviation meta experience', async () => {
    const { ctx, teardown } = await pipelineHarness()
    try {
      const { agent } = stubAgent('acceptance-gate-agent')
      ctx.agents.register(agent)
      await ctx.cognitivePipeline.defineAcceptanceCheck({
        criterion: '声称完成前必须给出证据来源',
        trigger: '声称完成',
        evidenceHint: '引用具体证据',
      })
      // Two violations: invoked=2 < acceptanceMinEvidenceCount=3 → no rework.
      for (let index = 0; index < 2; index += 1) {
        const audit = await ctx.cognitivePipeline.auditClaim({ claim: '声称完成某功能', situation: '实现中' })
        expect(audit.reworkNeeded).toBe(false)
      }
      // Third violation crosses invoked≥3 and deviation 3/3=1.0 ≥ 0.5.
      const crossing = await ctx.cognitivePipeline.auditClaim({ claim: '声称完成全部功能', situation: '实现中' })
      expect(crossing.reworkNeeded).toBe(true)
      expect(crossing.deviationExpId).not.toBeNull()
      const metaExps = ctx.cognitivePipeline.store.experiencesSnapshot().filter(exp => exp.meta === true)
      expect(metaExps.length).toBe(1)
      expect(metaExps[0]!.sar.situation).toContain('验收准则持续被违反')
      // The fourth audit is already past the crossing: no duplicate meta record.
      const again = await ctx.cognitivePipeline.auditClaim({ claim: '声称完成收尾', situation: '实现中' })
      expect(again.reworkNeeded).toBe(false)
      expect(again.deviationExpId).toBeNull()
      expect(ctx.cognitivePipeline.store.experiencesSnapshot().filter(exp => exp.meta === true).length).toBe(1)
      // inspect keeps listing the crossed criterion as a rewrite/retire candidate.
      const stats = ctx.cognitivePipeline.inspect().acceptance
      expect(stats.reworkCheckIds).toEqual(['check_1'])
      expect(stats.deviationRate).toBe(1)
    } finally {
      await teardown()
    }
  })

  it('rewrites active criteria but freezes retired ones', async () => {
    const { ctx, teardown } = await pipelineHarness()
    try {
      await ctx.cognitivePipeline.defineAcceptanceCheck({
        criterion: '原准则',
        trigger: 't1',
        evidenceHint: '证据提示',
      })
      const rewritten = await ctx.cognitivePipeline.updateAcceptanceCheck({
        checkId: 'check_1',
        criterion: '重写后的准则',
      })
      expect(rewritten.criterion).toBe('重写后的准则')
      expect(rewritten.revision).toBe(2)
      // The evidence ledger is preserved across rewrites.
      await ctx.cognitivePipeline.auditClaim({ claim: 't1 声称', situation: 'x' })
      const retired = await ctx.cognitivePipeline.updateAcceptanceCheck({ checkId: 'check_1', retire: true })
      expect(retired.status).toBe('retired')
      expect(retired.revision).toBe(3)
      await expect(ctx.cognitivePipeline.updateAcceptanceCheck({ checkId: 'check_1', criterion: 'x' }))
        .rejects.toThrow(/retired and frozen/)
      // Retired criteria are no longer applied by audits.
      const audit = await ctx.cognitivePipeline.auditClaim({ claim: 't1 声称', situation: 'x' })
      expect(audit.verdict).toBe('not-applicable')
      expect(audit.appliedCheckIds).toEqual([])
    } finally {
      await teardown()
    }
  })

  it('finds the most recent settled tool call in the ledger (findToolCallEvidence)', () => {
    const session = ledgerWithToolResults()
    const pwsh = findToolCallEvidence(session, 'pwsh')
    expect(pwsh).toEqual({ callId: 'call-1', succeeded: true })
    const git = findToolCallEvidence(session, 'git')
    expect(git).toEqual({ callId: 'call-2', succeeded: false })
    // Unknown tool and pending calls resolve to null.
    expect(findToolCallEvidence(session, 'nonexistent')).toBeNull()
    const pending = Session.create(SessionId('log-anchor-pending'))
    pending.append('turn/start', { turn: 1 })
    pending.append('tool/call', { turn: 1, step: 1, callId: CallId('call-9'), name: 'pwsh', arguments: '{}' })
    expect(findToolCallEvidence(pending, 'pwsh')).toBeNull()
  })

  it('lets the session ledger decide log-anchored audits and persists the anchor', async () => {
    const { ctx, root, teardown } = await pipelineHarness()
    try {
      const { agent } = stubAgent('log-anchor-agent')
      ctx.agents.register(agent)
      seedLedger(agent.session)
      await ctx.cognitivePipeline.defineAcceptanceCheck({
        criterion: '声称完成前必须给出证据来源',
        trigger: '声称完成',
        evidenceHint: '引用具体证据',
      })

      // A matched anchor satisfies: the ledger says pwsh succeeded.
      const verified = await executeTool(ctx, 'verify_claim', {
        claim: '已用 pwsh 验证完成，声称完成',
        situation: '实现验收清单',
        log_anchor: { tool_name: 'pwsh', expect_succeeded: true },
      }, agent) as Record<string, unknown>
      expect(verified.verdict).toBe('verified')
      expect(verified.anchor_verified).toBe(true)

      // A mismatched anchor violates even with self-reported evidence: the
      // ledger says git FAILED, so the claim that it succeeded is a false
      // verification the machine catches (the log is the witness).
      const caught = await executeTool(ctx, 'verify_claim', {
        claim: '已用 git 验证完成，声称完成',
        situation: '实现验收清单',
        evidence: '我确认 git 调用成功',
        log_anchor: { tool_name: 'git', expect_succeeded: true },
      }, agent) as Record<string, unknown>
      expect(caught.verdict).toBe('violated')
      expect(caught.anchor_verified).toBe(false)

      // An anchor naming a tool that never ran also violates.
      const missing = await executeTool(ctx, 'verify_claim', {
        claim: '已用 grep 验证完成，声称完成',
        situation: '实现验收清单',
        log_anchor: { tool_name: 'grep', expect_succeeded: true },
      }, agent) as Record<string, unknown>
      expect(missing.verdict).toBe('violated')

      // An anchor expecting failure matches the failed git call.
      const failedOk = await executeTool(ctx, 'verify_claim', {
        claim: 'git 调用确实失败，声称完成',
        situation: '实现验收清单',
        log_anchor: { tool_name: 'git', expect_succeeded: false },
      }, agent) as Record<string, unknown>
      expect(failedOk.verdict).toBe('verified')
      expect(failedOk.anchor_verified).toBe(true)

      // The ledger separates machine-witnessed passes from self-reported ones.
      const check = ctx.cognitivePipeline.store.getAcceptanceCheck('check_1')!
      expect(check.invokedCount).toBe(4)
      expect(check.passedCount).toBe(2)
      expect(check.violatedCount).toBe(2)
      expect(check.machineVerifiedCount).toBe(2)

      // The anchor persists through the filesystem round-trip.
      const store = new CognitiveStore(root)
      await store.load()
      const audits = store.claimAuditsSnapshot()
      expect(audits.length).toBe(4)
      const anchored = audits.find(audit => audit.anchor?.kind === 'log' && audit.anchor.toolName === 'pwsh')
      expect(anchored?.anchorVerified).toBe(true)
      expect(anchored?.anchor).toEqual({
        kind: 'log',
        toolName: 'pwsh',
        callId: 'call-1',
        expectedSucceeded: true,
        matched: true,
      })
      const refuted = audits.find(audit =>
        audit.anchor?.kind === 'log' && audit.anchor.toolName === 'git' && audit.anchor.expectedSucceeded)
      expect(refuted?.anchorVerified).toBe(false)
      expect(refuted?.anchor?.matched).toBe(false)
      expect(store.acceptanceSnapshot()[0]!.machineVerifiedCount).toBe(2)
    } finally {
      await teardown()
    }
  })

  it('lets the workspace disk decide file-anchored audits (可执行检查)', async () => {
    const { ctx, root, teardown } = await pipelineHarness()
    try {
      const { agent } = stubAgent('file-anchor-agent')
      ctx.agents.register(agent)
      const artifactPath = join(root, 'artifact.txt')
      await writeFile(artifactPath, '验收结果：通过\n', 'utf8')
      const digest = createHash('sha256').update('验收结果：通过\n').digest('hex')
      await ctx.cognitivePipeline.defineAcceptanceCheck({
        criterion: '声称完成前必须给出证据来源',
        trigger: '声称完成',
        evidenceHint: '引用具体证据',
      })

      // exists + contains + matches-hash all satisfy when the file matches.
      const exists = await executeTool(ctx, 'verify_claim', {
        claim: '验收产物已生成，声称完成',
        situation: '可执行检查',
        file_anchor: { path: artifactPath, expect: 'exists' },
      }, agent) as Record<string, unknown>
      expect(exists.verdict).toBe('verified')
      expect(exists.anchor_verified).toBe(true)

      const contains = await executeTool(ctx, 'verify_claim', {
        claim: '验收产物包含通过标记，声称完成',
        situation: '可执行检查',
        file_anchor: { path: artifactPath, expect: 'contains', text: '通过' },
      }, agent) as Record<string, unknown>
      expect(contains.verdict).toBe('verified')

      const hashOk = await executeTool(ctx, 'verify_claim', {
        claim: '验收产物哈希一致，声称完成',
        situation: '可执行检查',
        file_anchor: { path: artifactPath, expect: 'matches-hash', hash: digest },
      }, agent) as Record<string, unknown>
      expect(hashOk.verdict).toBe('verified')

      // A wrong hash, an absent file, and a wrong content expectation violate —
      // even with self-reported evidence (the disk is the witness).
      const wrongHash = await executeTool(ctx, 'verify_claim', {
        claim: '验收产物哈希一致，声称完成',
        situation: '可执行检查',
        evidence: '我确认哈希正确',
        file_anchor: { path: artifactPath, expect: 'matches-hash', hash: 'deadbeef' },
      }, agent) as Record<string, unknown>
      expect(wrongHash.verdict).toBe('violated')

      const absent = await executeTool(ctx, 'verify_claim', {
        claim: '缺失文件存在，声称完成',
        situation: '可执行检查',
        file_anchor: { path: join(root, 'never.txt'), expect: 'exists' },
      }, agent) as Record<string, unknown>
      expect(absent.verdict).toBe('violated')

      const wrongText = await executeTool(ctx, 'verify_claim', {
        claim: '验收产物包含失败标记，声称完成',
        situation: '可执行检查',
        file_anchor: { path: artifactPath, expect: 'contains', text: '失败' },
      }, agent) as Record<string, unknown>
      expect(wrongText.verdict).toBe('violated')

      // missing matches exactly when the file is absent; unreadable is fail-closed.
      const missingOk = await executeTool(ctx, 'verify_claim', {
        claim: '临时文件已清理，声称完成',
        situation: '可执行检查',
        file_anchor: { path: join(root, 'never.txt'), expect: 'missing' },
      }, agent) as Record<string, unknown>
      expect(missingOk.verdict).toBe('verified')

      const unreadable = await executeTool(ctx, 'verify_claim', {
        claim: '目录内容包含通过，声称完成',
        situation: '可执行检查',
        file_anchor: { path: root, expect: 'contains', text: '通过' },
      }, agent) as Record<string, unknown>
      expect(unreadable.verdict).toBe('violated')

      const check = ctx.cognitivePipeline.store.getAcceptanceCheck('check_1')!
      expect(check.invokedCount).toBe(8)
      expect(check.passedCount).toBe(4)
      expect(check.violatedCount).toBe(4)
      expect(check.machineVerifiedCount).toBe(4)

      // The file anchor persists through the round-trip.
      const store = new CognitiveStore(root)
      await store.load()
      const persisted = store.claimAuditsSnapshot().find(audit =>
        audit.anchor?.kind === 'file' && audit.anchor.path === artifactPath
        && audit.anchor.expect === 'contains' && audit.anchor.matched)
      expect(persisted?.anchorVerified).toBe(true)
      expect(persisted?.anchor).toEqual({
        kind: 'file',
        path: artifactPath,
        expect: 'contains',
        text: '通过',
        matched: true,
      })
    } finally {
      await teardown()
    }
  })

  it('lets the shell seam exit code decide command-anchored audits (可执行检查)', async () => {
    const { ctx, teardown } = await pipelineHarness({ acceptanceCommandExecution: true })
    try {
      StubShell.results = [runResult(0), runResult(1), runResult(1)]
      await ctx.plugin(StubShell)
      const { agent } = stubAgent('command-anchor-agent')
      ctx.agents.register(agent)
      await ctx.cognitivePipeline.defineAcceptanceCheck({
        criterion: '声称完成前必须给出证据来源',
        trigger: '声称完成',
        evidenceHint: '引用具体证据',
      })

      // Exit 0 with expect exit-zero satisfies.
      const ok = await executeTool(ctx, 'verify_claim', {
        claim: '检查命令通过，声称完成',
        situation: '命令检查',
        command_anchor: { command: 'node -e "process.exit(0)"', expect: 'exit-zero' },
      }, agent) as Record<string, unknown>
      expect(ok.verdict).toBe('verified')
      expect(ok.anchor_verified).toBe(true)

      // Exit 1 with expect exit-zero violates even with self-reported evidence.
      const failed = await executeTool(ctx, 'verify_claim', {
        claim: '检查命令通过，声称完成',
        situation: '命令检查',
        evidence: '我确认命令成功了',
        command_anchor: { command: 'node -e "process.exit(1)"', expect: 'exit-zero' },
      }, agent) as Record<string, unknown>
      expect(failed.verdict).toBe('violated')
      expect(failed.anchor_verified).toBe(false)

      // Exit 1 with expect exit-nonzero satisfies.
      const nonzeroOk = await executeTool(ctx, 'verify_claim', {
        claim: '检查命令如预期失败，声称完成',
        situation: '命令检查',
        command_anchor: { command: 'node -e "process.exit(1)"', expect: 'exit-nonzero' },
      }, agent) as Record<string, unknown>
      expect(nonzeroOk.verdict).toBe('verified')

      // The command anchor persists with its observed exit code.
      const audit = ctx.cognitivePipeline.store.claimAuditsSnapshot()
        .find(item => item.anchor?.kind === 'command' && item.anchor.matched)
      expect(audit?.anchor).toEqual({
        kind: 'command',
        command: 'node -e "process.exit(0)"',
        expect: 'exit-zero',
        exitCode: 0,
        matched: true,
      })
    } finally {
      await teardown()
    }
  })

  it('fails command anchors closed on timeout and signal death, and rejects when disabled or shell absent', async () => {
    // A timed-out run and a signal death settle without a usable exit code.
    const timed = await pipelineHarness({ acceptanceCommandExecution: true })
    try {
      StubShell.results = [runResult(0, { timedOut: true }), runResult(null, { signal: 'SIGTERM' })]
      await timed.ctx.plugin(StubShell)
      await timed.ctx.cognitivePipeline.defineAcceptanceCheck({
        criterion: '声称完成前必须给出证据来源',
        trigger: '声称完成',
        evidenceHint: '引用具体证据',
      })
      const timedOut = await executeTool(timed.ctx, 'verify_claim', {
        claim: '慢命令通过，声称完成',
        situation: '命令检查',
        command_anchor: { command: 'sleep 60', expect: 'exit-zero' },
      }) as Record<string, unknown>
      expect(timedOut.verdict).toBe('violated')
      const killed = await executeTool(timed.ctx, 'verify_claim', {
        claim: '被信号终止的命令通过，声称完成',
        situation: '命令检查',
        command_anchor: { command: 'kill -9 $$', expect: 'exit-zero' },
      }) as Record<string, unknown>
      expect(killed.verdict).toBe('violated')
    } finally {
      await timed.teardown()
    }

    // Command execution is OFF by default: the tool refuses loudly.
    const disabled = await pipelineHarness()
    try {
      await disabled.ctx.cognitivePipeline.defineAcceptanceCheck({
        criterion: '声称完成前必须给出证据来源',
        trigger: '声称完成',
        evidenceHint: '引用具体证据',
      })
      await expect(executeTool(disabled.ctx, 'verify_claim', {
        claim: '命令检查通过，声称完成',
        situation: '命令检查',
        command_anchor: { command: 'node -e "process.exit(0)"', expect: 'exit-zero' },
      })).rejects.toThrow(/command anchors are disabled/)
    } finally {
      await disabled.teardown()
    }

    // Enabled but no shell capability mounted: fail loud, never silently degrade.
    const shelless = await pipelineHarness({ acceptanceCommandExecution: true })
    try {
      await shelless.ctx.cognitivePipeline.defineAcceptanceCheck({
        criterion: '声称完成前必须给出证据来源',
        trigger: '声称完成',
        evidenceHint: '引用具体证据',
      })
      await expect(executeTool(shelless.ctx, 'verify_claim', {
        claim: '命令检查通过，声称完成',
        situation: '命令检查',
        command_anchor: { command: 'node -e "process.exit(0)"', expect: 'exit-zero' },
      })).rejects.toThrow(/shell capability/)
    } finally {
      await shelless.teardown()
    }
  })

  it('proposes and gates acceptance-criterion updates from evidence (经验门槛验收)', async () => {
    const proposal = JSON.stringify({
      proposals: [
        {
          check_id: 'check_1',
          action: 'rewrite',
          criterion: '声称完成前必须给出可核验证据',
          evidence_hint: '引用日志/文件/命令检查中的具体证据',
          trigger: '声称完成',
          rationale: '违规率 100%（3/3），账本证明原准则无法被满足，需放宽为可核验证据',
        },
        { check_id: 'check_9', action: 'retire', rationale: '目标不存在，应被闸门拒绝' },
        { check_id: 'check_1', action: 'rewrite', rationale: '缺少重写文本，应被解析丢弃' },
      ],
    })
    const { ctx, adapter, teardown } = await pipelineHarness({ provider: 'cognition-test', model: 'm' }, [proposal])
    try {
      await ctx.cognitivePipeline.defineAcceptanceCheck({
        criterion: '声称完成前必须给出证据来源',
        trigger: '声称完成',
        evidenceHint: '引用具体证据',
      })
      // Three unverified audits make check_1 demonstrably failing (3/3, ≥3 invoked).
      for (let index = 0; index < 3; index += 1) {
        await ctx.cognitivePipeline.auditClaim({ claim: '声称完成某功能', situation: '实现中' })
      }
      const result = await ctx.cognitivePipeline.proposeAcceptanceUpdate()
      expect(result.flagged.map(check => check.checkId)).toEqual(['check_1'])
      // The route kept the valid and the wrong-target proposals; the parser
      // dropped the rewrite without text.
      expect(result.proposals.length).toBe(2)
      // The gate applied only the valid one — wrong-target was rejected.
      expect(result.applied.length).toBe(1)
      expect(adapter?.consumed).toBe(1)
      const check = ctx.cognitivePipeline.store.getAcceptanceCheck('check_1')!
      expect(check.criterion).toBe('声称完成前必须给出可核验证据')
      expect(check.evidenceHint).toBe('引用日志/文件/命令检查中的具体证据')
      expect(check.revision).toBe(2)
      // The evidence ledger survives the rewrite untouched.
      expect(check.invokedCount).toBe(3)
      expect(check.violatedCount).toBe(3)
    } finally {
      await teardown()
    }
  })

  it('proposes nothing without a failing criterion or an explicit route, and retires via proposal', async () => {
    // No failing criterion → no LLM call, nothing proposed.
    const quiet = await pipelineHarness(
      { provider: 'cognition-test', model: 'm' },
      [JSON.stringify({ proposals: [] })],
    )
    try {
      await quiet.ctx.cognitivePipeline.defineAcceptanceCheck({
        criterion: 'c',
        trigger: 't',
        evidenceHint: 'e',
      })
      await quiet.ctx.cognitivePipeline.auditClaim({ claim: 't 声明', situation: 'x' })
      const none = await quiet.ctx.cognitivePipeline.proposeAcceptanceUpdate()
      expect(none.flagged.length).toBe(0)
      expect(none.applied.length).toBe(0)
      expect(quiet.adapter?.consumed).toBe(0)
    } finally {
      await quiet.teardown()
    }

    // Failing criterion + retire proposal → the gate applies the retirement.
    const retire = JSON.stringify({ proposals: [{ check_id: 'check_1', action: 'retire', rationale: '触发条件不再适用' }] })
    const routed = await pipelineHarness({ provider: 'cognition-test', model: 'm' }, [retire])
    try {
      await routed.ctx.cognitivePipeline.defineAcceptanceCheck({
        criterion: '声称完成前必须给出证据来源',
        trigger: '声称完成',
        evidenceHint: '引用具体证据',
      })
      for (let index = 0; index < 3; index += 1) {
        await routed.ctx.cognitivePipeline.auditClaim({ claim: '声称完成某功能', situation: '实现中' })
      }
      const result = await routed.ctx.cognitivePipeline.proposeAcceptanceUpdate()
      expect(result.applied.length).toBe(1)
      expect(routed.ctx.cognitivePipeline.store.getAcceptanceCheck('check_1')!.status).toBe('retired')
      expect(routed.ctx.cognitivePipeline.store.getAcceptanceCheck('check_1')!.revision).toBe(2)
    } finally {
      await routed.teardown()
    }

    // No explicit route → deterministically nothing (no self-legislation unjudged).
    const routeless = await pipelineHarness()
    try {
      await routeless.ctx.cognitivePipeline.defineAcceptanceCheck({
        criterion: 'c',
        trigger: 't',
        evidenceHint: 'e',
      })
      for (let index = 0; index < 3; index += 1) {
        await routeless.ctx.cognitivePipeline.auditClaim({ claim: 't 声明', situation: 'x' })
      }
      const none = await routeless.ctx.cognitivePipeline.proposeAcceptanceUpdate()
      expect(none.flagged.length).toBe(1)
      expect(none.applied.length).toBe(0)
    } finally {
      await routeless.teardown()
    }
  })
})
