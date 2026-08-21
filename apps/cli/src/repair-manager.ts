/**
 * Startup self-healing: when a profile boot fails, diagnose the failed
 * plugins and apply the narrowest reversible repair — a temporary disable
 * overlay for the failed plugin, written under `$DSH_HOME/startup-repair/`
 * — then append a JSONL repair log entry so every automatic change is
 * reviewable and rollbackable. Only reversible repairs are automatic:
 * dependency-declaration or install-level problems are logged as advice,
 * never auto-edited.
 * @module @deepseek-ai/dsh/repair-manager
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { StartupFailure, StartupRepair } from '@deepseek-ai/dsh-app-boot'

/** Root holding temporary repair overlays and the repair log. */
export function repairRoot(): string {
  return join(resolveDshHome(), 'startup-repair')
}

/** The JSONL repair log path (one entry per automatic repair attempt). */
export function repairLogPath(): string {
  return join(repairRoot(), 'repair.log')
}

/** One repair log entry: what failed, what was diagnosed, what was changed. */
export interface RepairLogEntry {
  readonly ts: string
  readonly profile: string
  readonly stage: string
  readonly failedPlugins: readonly string[]
  readonly diagnosis: string
  readonly repairs: readonly {
    readonly kind: string
    readonly target: string
    readonly artifact: string
    readonly rollback: string
  }[]
  readonly result: 'applied' | 'no-repair' | 'failed'
  readonly retry: boolean
}

/** Profile name the repair targets (from the launch environment). */
const PROFILE = process.env.DSH_PROFILE ?? 'unknown'

/**
 * Diagnose a startup failure and apply the narrowest reversible repair.
 * Activation failures (a plugin's fiber never settled) get a temporary
 * disable overlay for the failed plugin — the minimal change that lets the
 * rest of the tree boot. Host-preparation failures and unresolved bare
 * specifiers are logged as advice only: they point at infrastructure or
 * dependency-declaration problems that a disable cannot fix, and auto-editing
 * manifests is not reversible.
 * @param failure - the startup failure facts from {@link boot}.
 * @returns the repair outcome, or null when no reversible repair applies.
 */
export function repairStartupFailure(failure: StartupFailure): StartupRepair | null {
  const entry: RepairLogEntry = diagnose(failure)
  appendLog(entry)
  if (entry.repairs.length === 0 || entry.result !== 'applied') return null
  return {
    summary: entry.repairs.map(repair => `临时禁用 ${repair.target}`).join('；'),
    logPath: repairLogPath(),
    retry: true,
  }
}

/** Classify the failure and produce the repair list (side-effect free). */
function diagnose(failure: StartupFailure): RepairLogEntry {
  const now = new Date().toISOString()
  const repairs: { kind: string; target: string; artifact: string; rollback: string }[] = []
  const writeErrors: string[] = []
  let result: RepairLogEntry['result'] = 'no-repair'
  if (failure.stage === 'plugin tree failed to load' && failure.failedPlugins.length > 0) {
    for (const name of failure.failedPlugins) {
      try {
        const overlay = disableOverlayFor(name)
        writeFileSync(overlay.path, overlay.content)
        repairs.push({
          kind: 'disable',
          target: name,
          artifact: overlay.path,
          rollback: `删除 ${overlay.path}`,
        })
      } catch (error: unknown) {
        result = 'failed'
        writeErrors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (result !== 'failed') result = 'applied'
  }
  const diagnosis = failure.stage === 'host preparation failed'
    ? '主机准备失败（基础设施问题），临时禁用插件无法修复，仅记录'
    : failure.failedPlugins.length === 0
      ? '未定位到失败插件，仅记录'
      : writeErrors.length > 0
        ? `overlay 写入失败：${writeErrors.join('；')}`
        : `已为 ${failure.failedPlugins.length} 个失败插件生成临时禁用 overlay；解析失败类问题仍需补依赖声明`
  return {
    ts: now,
    profile: PROFILE,
    stage: failure.stage,
    failedPlugins: [...failure.failedPlugins],
    diagnosis,
    repairs,
    result,
    retry: result === 'applied',
  }
}

/** Build one disable overlay file for a failed plugin. */
function disableOverlayFor(name: string): { path: string; content: string } {
  mkdirSync(repairRoot(), { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const safe = name.replace(/[^a-zA-Z0-9-]/g, '-')
  return {
    path: join(repairRoot(), `disable-${safe}-${stamp}.yml`),
    content: `# 临时修复 overlay：禁用启动失败的插件 ${name}\n# 由 dsh 启动自愈生成；确认问题解决后删除本文件并移除 --patch 引用。\n- id: ${name}\n  disabled: true\n`,
  }
}

/** Append one entry to the JSONL repair log (creates the directory). */
function appendLog(entry: RepairLogEntry): void {
  try {
    mkdirSync(repairRoot(), { recursive: true })
    appendFileSync(repairLogPath(), `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {
    // A log write failure must not mask the startup failure it describes;
    // the thrown boot error still carries the original detail.
  }
}
