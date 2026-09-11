/**
 * Goal-trajectory panel, node half.
 *
 * Serves one read-only endpoint over the connection's generic RPC carrier —
 * `POST /goal-tree/trajectory/overview` — that returns the trajectory snapshot
 * the out-of-tree generator (`dsh-goal-trajectory.py`) writes to
 * `$DSH_HOME/cognitive-pipeline/goal-trajectory.json`. The browser half renders
 * it; nothing here renders and nothing here mutates: the endpoint either reads
 * the published file or, on request, re-runs the generator first.
 *
 * Why its own channel instead of the shared `/api` one: Connection allows a
 * single interceptor per channel, and the Typert gateway already owns `/api`,
 * so a second interceptor would be a boot-order race. A private channel is
 * additive, carries the same trust fence and envelope, and needs no change to
 * any shared package.
 *
 * @module @deepseek-ai/dsh-client-ui-goal-tree
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  GOAL_TREE_CHANNEL,
  GOAL_TREE_ENDPOINT,
  TRAJECTORY_FILE_NAME,
  TRAJECTORY_SCRIPT_RELATIVE,
  type GoalTrajectoryOverview,
  type GoalTrajectoryRequest,
  type GoalTrajectorySnapshot,
} from './client/contract/goal-trajectory.ts'

/** Stable Cordis plugin name. */
export const name = 'ui-goal-tree'

/** Services required before the endpoint can be registered: the transport (which owns the route) and its web server. */
export const inject = ['webServer', 'connection']

/** Plugin config. */
export interface Config {
  /** Directory holding the pipeline state files; defaults to `$DSH_HOME/cognitive-pipeline`. */
  stateDir?: string
  /** Absolute generator script path; defaults to `dsh-goal-trajectory.py` at the checkout root this plugin was built in. */
  scriptPath?: string
  /** Wall-clock ceiling for one generator run, in milliseconds. */
  generatorTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  stateDir: z.string(),
  scriptPath: z.string(),
  generatorTimeoutMs: z.natural().default(20_000),
})

const execFileAsync = promisify(execFile)

/** The shape this endpoint's result slot carries; the compiler checks it against Connection's `RpcResult`. */
type OverviewResult =
  | { readonly ok: true; readonly value: GoalTrajectoryOverview }
  | { readonly ok: false; readonly error: { readonly code: 'internal'; readonly message: string; readonly details: Record<string, never> } }

/**
 * Resolve the harness home the way the boot layer does: `DSH_HOME` wins, and an
 * empty or whitespace-only value falls back to `~/.dsh`.
 * @returns absolute harness home directory.
 */
function resolveDshHome(): string {
  const fromEnv = process.env['DSH_HOME']
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/**
 * Locate the generator script shipped in the checkout this plugin was built
 * from. This file compiles to `<repo>/packages/client/ui-goal-tree/lib/index.js`,
 * so four levels up is the repository root.
 * @returns candidate absolute script path (the configured path is still honoured first).
 */
function defaultScriptPath(): string {
  const libDir = fileURLToPath(new URL('.', import.meta.url))
  return join(libDir, '..', '..', '..', '..', TRAJECTORY_SCRIPT_RELATIVE)
}

/**
 * Validate the generated document just enough that a malformed or truncated
 * file reports a correction instead of silently rendering an empty panel. The
 * file is produced outside the harness, so this is a boundary check rather than
 * a schema: unknown fields pass through and reach the browser verbatim.
 * @param value - parsed JSON.
 * @param path - source path, for the failure message.
 * @returns the validated document.
 * @throws when the document is not a trajectory snapshot.
 */
export function assertSnapshot(value: unknown, path: string): GoalTrajectorySnapshot {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${path}: not a JSON object`)
  }
  const document = value as Record<string, unknown>
  if (!Array.isArray(document['goals'])) {
    throw new Error(`${path}: "goals" is not an array`)
  }
  for (const [index, goal] of document['goals'].entries()) {
    if (typeof goal !== 'object' || goal === null) throw new Error(`${path}: goals[${String(index)}] is not an object`)
    const row = goal as Record<string, unknown>
    for (const field of ['id', 'title', 'lane'] as const) {
      if (typeof row[field] !== 'string') throw new Error(`${path}: goals[${String(index)}].${field} is missing`)
    }
    if (!Array.isArray(row['steps'])) throw new Error(`${path}: goals[${String(index)}].steps is not an array`)
  }
  return document as unknown as GoalTrajectorySnapshot
}

/**
 * Read and validate the generated snapshot.
 * @param path - absolute snapshot path.
 * @returns the validated snapshot.
 */
export async function readSnapshot(path: string): Promise<GoalTrajectorySnapshot> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw new Error(
      `goal-trajectory: cannot read ${path} (${error instanceof Error ? error.message : String(error)}); `
      + 'run the generator once, or refresh with regenerate=true',
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`goal-trajectory: ${path} is not valid JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  return assertSnapshot(parsed, path)
}

/**
 * Run the generator, which rewrites the snapshot file before this resolves. A
 * non-zero exit or a timeout is a hard failure: the caller reports it rather
 * than silently serving a stale file the operator believes was refreshed.
 * @param options - script path, working directory, and wall-clock ceiling.
 * @returns the generator's trimmed stdout.
 */
export async function runGenerator(options: {
  readonly script: string
  readonly cwd: string
  readonly timeoutMs: number
}): Promise<string> {
  const { stdout } = await execFileAsync('python3', [options.script], {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  }) as { stdout: string }
  return stdout.trim()
}

/**
 * Answer one overview call. Never throws: every failure becomes the error branch,
 * which is what the carrier turns into a 200 + failure envelope.
 * @param request - decoded request payload (absent payload = a plain read).
 * @param options - resolved state directory, script path, and generator ceiling.
 * @returns the RPC result slot.
 */
export async function overviewResult(
  request: GoalTrajectoryRequest,
  options: { readonly stateDir: string; readonly script: string; readonly timeoutMs: number },
): Promise<OverviewResult> {
  const path = join(options.stateDir, TRAJECTORY_FILE_NAME)
  let regenerated = false
  try {
    if (request.regenerate === true) {
      await runGenerator({ script: options.script, cwd: options.stateDir, timeoutMs: options.timeoutMs })
      regenerated = true
    }
    const snapshot = await readSnapshot(path)
    return { ok: true, value: { snapshot, path, regenerated, readAt: Date.now() } }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'internal',
        message: error instanceof Error ? error.message : String(error),
        details: {},
      },
    }
  }
}

/**
 * The slice of the Host connection service this endpoint uses, declared
 * structurally instead of imported from `@deepseek-ai/dsh-client-connection`:
 * that package's root module is the HTTP host half (node-only), and importing
 * it here would drag another project's node sources into this package's client
 * compilation. The shape is the service's documented `rpc.handle` contract.
 */
interface HostConnectionRpcPort {
  handle(
    channel: string,
    handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<OverviewResult>,
    options: { readonly authority: 'trusted-host' | 'loopback' },
  ): () => Promise<void>
}

/**
 * Register the endpoint. Its route belongs to the connection service, so
 * disposal rides `ctx.effect` and unloads with the plugin.
 * @param ctx - plugin context carrying `connection` and `webServer`.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const stateDir = config.stateDir ?? join(resolveDshHome(), 'cognitive-pipeline')
  const script = config.scriptPath ?? defaultScriptPath()
  const timeoutMs = config.generatorTimeoutMs ?? 20_000
  const connection = ctx.get('connection') as { readonly rpc: HostConnectionRpcPort } | undefined
  if (connection === undefined) {
    ctx.logger.warn('ui-goal-tree: connection service absent; the goal-trajectory endpoint is not served')
    return
  }
  ctx.effect(
    () => connection.rpc.handle(
      GOAL_TREE_CHANNEL,
      (endpoint, payload) => {
        // The carrier already refused a method/endpoint mismatch; this endpoint
        // re-checks because an unknown endpoint would otherwise read as a hit.
        if (endpoint !== GOAL_TREE_ENDPOINT) {
          return Promise.resolve({
            ok: false as const,
            error: { code: 'internal' as const, message: `unknown endpoint ${endpoint}`, details: {} },
          })
        }
        const request = (typeof payload === 'object' && payload !== null ? payload : {}) as GoalTrajectoryRequest
        return overviewResult(request, { stateDir, script, timeoutMs })
      },
      { authority: 'loopback' },
    ),
    'ui-goal-tree: goal-trajectory endpoint',
  )
  ctx.logger.info(`ui-goal-tree: serving ${GOAL_TREE_CHANNEL}/${GOAL_TREE_ENDPOINT} from ${stateDir}`)
}
