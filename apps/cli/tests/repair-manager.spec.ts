import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repairLogPath, repairRoot, repairStartupFailure } from '../src/repair-manager.ts'
import type { StartupFailure } from '@deepseek-ai/dsh-app-boot'

/** Point DSH_HOME at a throwaway dir for the duration of one test. */
function withHome(work: (home: string) => void | Promise<void>): void {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    void work(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

describe('startup repair manager', () => {
  it('writes a temporary disable overlay and a JSONL log entry for failed plugins', () => {
    withHome(() => {
      const failure: StartupFailure = {
        stage: 'plugin tree failed to load',
        detail: 'dsh: plugin(s) failed to load: broken-plugin; Cordis startup failed',
        failedPlugins: ['broken-plugin'],
      }
      const repair = repairStartupFailure(failure)

      expect(repair).not.toBeNull()
      expect(repair?.summary).toContain('临时禁用 broken-plugin')
      expect(repair?.logPath).toBe(repairLogPath())
      expect(repair?.retry).toBe(true)

      // One disable overlay exists for the failed plugin.
      const overlays = readdirSync(repairRoot()).filter(file => file.startsWith('disable-broken-plugin-'))
      expect(overlays.length).toBe(1)
      const overlay = readFileSync(join(repairRoot(), overlays[0]!), 'utf8')
      expect(overlay).toContain('id: broken-plugin')
      expect(overlay).toContain('disabled: true')

      // The log entry records the diagnosis, artifact, and rollback.
      const log = readFileSync(repairLogPath(), 'utf8')
      const entry = JSON.parse(log.trim().split('\n').at(-1)!) as {
        stage: string
        failedPlugins: string[]
        repairs: { kind: string; target: string; rollback: string }[]
        result: string
        retry: boolean
      }
      expect(entry.stage).toBe('plugin tree failed to load')
      expect(entry.failedPlugins).toEqual(['broken-plugin'])
      expect(entry.repairs[0]?.kind).toBe('disable')
      expect(entry.repairs[0]?.target).toBe('broken-plugin')
      expect(entry.repairs[0]?.rollback).toContain('删除')
      expect(entry.result).toBe('applied')
      expect(entry.retry).toBe(true)
    })
  })

  it('logs only (no repair) for a host-preparation failure', () => {
    withHome(() => {
      const failure: StartupFailure = {
        stage: 'host preparation failed',
        detail: 'dsh: host preparation failed: boom',
        failedPlugins: [],
      }
      const repair = repairStartupFailure(failure)

      expect(repair).toBeNull()
      // No disable overlay was written, but the diagnosis is logged.
      expect(existsSync(repairLogPath())).toBe(true)
      const entry = JSON.parse(readFileSync(repairLogPath(), 'utf8').trim()) as { result: string }
      expect(entry.result).toBe('no-repair')
    })
  })

  it('reports overlay write failures without throwing (log write is best-effort)', () => {
    withHome((home) => {
      // Make the repair root unwritable: create a FILE at the root path.
      writeFileSync(join(home, 'startup-repair'), 'blocked')
      const failure: StartupFailure = {
        stage: 'plugin tree failed to load',
        detail: 'failed',
        failedPlugins: ['broken-plugin'],
      }
      // Must not throw: the startup failure it describes stays the outcome.
      const repair = repairStartupFailure(failure)
      expect(repair).toBeNull()
    })
  })
})
