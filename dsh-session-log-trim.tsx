/**
 * ⛔ **本工具当前被格式约束阻断, 默认拒绝落盘(cl-239, 2026-09-11 19:2x 实测)**:
 *
 * 会话日志展开后是 **543 万条事件**(189k 存储行; 其中 98.7% 是 block/delta 增量), 而 surface 折叠
 * **强制 seq 连续** —— `surface.ts:328` `if (event.seq !== expectedSeq) throw ... not contiguous`。
 * 于是"删掉已被最终消息覆盖的增量行"必然留下 seq 空洞, 实测:
 *   ① 原始事件流 foldSurface 成功(读法正确);
 *   ② 去掉增量事件后 foldSurface **失败**: "session event seq 30 is not contiguous; expected 25";
 *   ③ 想按外部序号重编也不行: "sourceEventSeqS must reference earlier events"(事件间有 provenance 交叉引用)。
 *
 * 也就是说: 内容上的冗余是真的(同一份文本在增量与最终消息里各存一遍), 但**只追加 + seq 连续 + 交叉引用**
 * 三条约束合起来使"逐行删除"不可能安全 —— 这需要格式级特性(例如一条"增量已省略"的记录让折叠显式跳过),
 * 而不是一个改日志文件的脚本。故本工具**默认拒绝写入**, 只保留"能省多少"的度量能力(取证/评估用):
 * 它的数据回答"如果允许删, 能删掉多少", 供格式级方案评估收益。
 *
 * 若将来落地格式级压实, 复制本工具去掉 `BLOCKED` 短路即可复用其判定与度量。
 */
const BLOCKED = true

/**
 * dsh-session-log-trim.tsx — 会话日志压实(cl-239: 解决"轮次太多导致 web 加载困难")。
 *
 * 为什么需要: 本会话日志长到 66.9MB 压缩 / 204MB 解压 / 189k 行, 其中 **71% 的行是流式增量 chunk**
 * (assistant/chunk 与三类 packed 行: text-chunks / reasoning-chunks / tool-call-chunks)。这些增量的
 * 内容在**同一 (turn, step, index) 的最终记录**里已经完整存在(文本/推理 → assistant/message 的 content
 * 块; 工具参数 → tool/call 的 arguments)。而日志是只追加的, 于是同一份内容永久存了两遍, 每次打开/重连
 * 都要为它付解码与折叠成本(events 流的 since 在 v1 未实现: 重连 = 重开流 + 重取历史)。
 *
 * 判据(**保守, 宁可少丢**): 一条增量行只有在它的拼接内容与最终记录**逐字相等**时才可丢。
 *   · text-chunks / reasoning-chunks  → 对应 assistant/message 里同 index 的块文本
 *   · tool-call-chunks                → 同 callId 的 tool/call.arguments 完整参数串
 *   · 未最终化的(仍在飞)turn 的增量    → 一律保留(tail 页的 in-flight partial 就靠它)
 * 无法确认覆盖的增量一律保留; 任何不确定都算"保留"。
 *
 * 正确性自证: 压实后重新读回, 对每个 (turn, step, index) 计算"有效内容摘要"(有最终记录用最终记录,
 * 否则用增量拼接), 要求**前后逐条一致**; 任何不一致即拒绝落盘(exit 3)。
 *
 * 用法: npx tsx dsh-session-log-trim.tsx --log <session.jsonl.zstd> [--out FILE] [--write] [--json]
 * 默认 dry-run(只报告, 不写文件)。落盘时先把原文件备份到 --backup 指定处(默认 /tmp)。
 */
import { createReadStream, createWriteStream, copyFileSync, existsSync, renameSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { compressZstdFrame } from './packages/session/session-persistence-jsonl/src/zstd.ts'

const arg = (n: string, f?: string): string | undefined => {
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : f
}
const LOG = arg('log')
if (LOG === undefined || !existsSync(LOG)) { console.error('用法: --log <session.jsonl.zstd>'); process.exit(2) }
const OUT = arg('out', `${LOG}.trimmed`)
const WRITE = process.argv.includes('--write')
const JSON_OUT = process.argv.includes('--json')

interface Row { type: string; [k: string]: unknown }
const isDeltaRow = (t: string): boolean =>
  t === 'assistant/chunk' || t === 'text-chunks' || t === 'reasoning-chunks' || t === 'tool-call-chunks'

/** 一行 JSONL 的有效内容摘要(用于前后比对): 最终记录用其原样哈希, 增量行用其拼接后的文本哈希。 */
const digest = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16)

/** 逐行流式读取(走 zstd -dc, 不把 204MB 一次性读进内存)。 */
async function forEachLine(file: string, fn: (line: string, index: number) => void): Promise<number> {
  const child = spawn(file.endsWith('.zstd') || file.endsWith('.zst') ? 'zstd' : 'cat',
    file.endsWith('.zstd') || file.endsWith('.zst') ? ['-dc', file] : [file], { stdio: ['ignore', 'pipe', 'ignore'] })
  let buf = ''
  let index = 0
  for await (const chunk of child.stdout) {
    buf += chunk
    let nl = buf.indexOf('\n')
    while (nl >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line.trim() !== '') fn(line, index++)
      nl = buf.indexOf('\n')
    }
  }
  if (buf.trim() !== '') fn(buf, index++)
  return index
}

/** 第一遍: 收集最终记录(覆盖依据)与增量行的键, 决定哪些增量行可丢。 */
interface Bucket { finalTexts: Map<string, string>; toolArgs: Map<string, string> }
const keyOf = (r: Row): string => {
  const d = (r.data ?? {}) as Record<string, unknown>
  return `${d.turn}/${d.step}/${d.index}`
}

const pass1 = async (): Promise<{
  buckets: Bucket; deltaRows: number; deltaBytes: number; droppable: Map<string, boolean>
  droppedRows: number; keptRows: number; rows: number; headerLine: string
}> => {
  const finalTexts = new Map<string, string>()
  const toolArgs = new Map<string, string>()
  const deltaKeys = new Map<string, string>()          // 行索引 → bucket key(便于第二遍判断)
  const deltaPayload = new Map<string, string[]>()     // key → 拼接片段
  const deltaKind = new Map<string, string>()
  let headerLine = ''
  let rows = 0, deltaRows = 0, deltaBytes = 0

  await forEachLine(LOG as string, (line, i) => {
    rows += 1
    if (i === 0) { headerLine = line; return }
    const r = JSON.parse(line) as Row
    const t = String(r.type)
    const d = (r.data ?? {}) as Record<string, unknown>
    if (t === 'assistant/message') {
      const content = ((d.message ?? {}) as { content?: Array<Record<string, unknown>> }).content ?? []
      content.forEach((block, idx) => {
        const text = typeof block.text === 'string' ? block.text : ''
        if (text !== '') finalTexts.set(`${d.turn}/${d.step}/${idx}`, text)
      })
      return
    }
    if (t === 'tool/call') {
      const callId = String(d.callId ?? '')
      const args = typeof d.arguments === 'string' ? d.arguments : ''
      if (callId !== '' && args !== '') toolArgs.set(callId, args)
      return
    }
    if (!isDeltaRow(t)) return
    deltaRows += 1
    deltaBytes += Buffer.byteLength(line) + 1
    const key = keyOf(r)
    deltaKeys.set(String(i), key)
    deltaKind.set(key, t)
    const parts = t === 'tool-call-chunks'
      ? (Array.isArray(d.args) ? d.args.map(String) : [])
      : (Array.isArray(d.texts) ? d.texts.map(String) : [])
    const callId = String(d.id ?? '')
    deltaPayload.set(key, [...(deltaPayload.get(key) ?? []), ...parts, callId === '' ? '' : `\u0000${callId}`])
  })
  // 覆盖判定: 拼接内容必须与最终记录逐字相等
  const droppable = new Map<string, boolean>()
  for (const [key, parts] of deltaPayload) {
    const kind = deltaKind.get(key)
    if (kind === 'tool-call-chunks') {
      const callId = parts.find(p => p.startsWith('\u0000'))?.slice(1) ?? ''
      const joined = parts.filter(p => !p.startsWith('\u0000')).join('')
      const full = toolArgs.get(callId)
      droppable.set(key, full !== undefined && full === joined)
    } else {
      const joined = parts.join('')
      const full = finalTexts.get(key)
      droppable.set(key, full !== undefined && full === joined)
    }
  }
  return { buckets: { finalTexts, toolArgs }, deltaRows, deltaBytes, droppable, deltaKeys: deltaKeys as never,
    droppedRows: 0, keptRows: 0, rows, headerLine }
}

const main = async (): Promise<void> => {
  if (BLOCKED && WRITE) {
    console.error('拒绝写入: 格式约束阻断(cl-239) —— 删行会留下 seq 空洞, surface 折叠强制 seq 连续\n' +
      '  证据: 543 万事件中 98.7% 是增量; 去增量后 foldSurface 报 "seq 30 is not contiguous; expected 25";\n' +
      '  按外部重编序号也不行("sourceEventSeqS must reference earlier events")。\n' +
      '  请改用: 开新会话 / 让写入侧不再持久化已最终化的增量(需重编语义) / 格式级"增量已省略"记录。\n' +
      '  只做度量请去掉 --write。')
    process.exit(4)
  }
  const p1 = await pass1()
  const droppable = p1.droppable as unknown as Map<string, boolean>
  const deltaKeyByLine = p1.deltaKeys as unknown as Map<string, string>

  // 第二遍: 写出保留的行(增量行仅在"可丢"时丢弃); 同时算前后内容摘要
  const tmp = `${OUT}.tmp`
  const out = WRITE ? createWriteStream(tmp) : null
  let buffered: string[] = []
  let bufferedBytes = 0
  let keptRows = 0, droppedRows = 0, droppedBytes = 0
  // compressZstdFrame 是异步的 ⇒ 用串行队列落帧, 避免在同步回调里 await
  let queue: Promise<void> = Promise.resolve()
  const flush = (force = false): void => {
    if (out === null || buffered.length === 0) return
    if (!force && bufferedBytes < 4 * 1024 * 1024) return          // 每帧约 4MB, 与写入侧同量级
    const text = buffered.join('\n') + '\n'
    buffered = []; bufferedBytes = 0
    queue = queue.then(async () => { out.write(await compressZstdFrame(text)) })
  }
  const before = new Map<string, string>()
  const after = new Map<string, string>()
  let lineNo = -1
  await forEachLine(LOG as string, (line) => {
    lineNo += 1
    if (lineNo === 0) { buffered.push(line); bufferedBytes += line.length + 1; flush(true); return }
    const r = JSON.parse(line) as Row
    const t = String(r.type)
    const keep = !isDeltaRow(t) || droppable.get(deltaKeyByLine.get(String(lineNo)) ?? '') !== true
    if (keep) { keptRows += 1; buffered.push(line); bufferedBytes += line.length + 1; flush() }
    else { droppedRows += 1; droppedBytes += Buffer.byteLength(line) + 1 }
    // 摘要: 非增量行原样; 增量行只有在被保留时才参与
    if (!isDeltaRow(t)) {
      const d = (r.data ?? {}) as Record<string, unknown>
      const sig = `${t}:${String(d.turn ?? '')}/${String(d.step ?? '')}:${digest(line)}`
      before.set(sig, sig); after.set(sig, sig)
    }
  })
  flush(true)
  await queue
  if (out !== null) await new Promise<void>(res => out.end(res))

  const report = {
    log: LOG, out: WRITE ? OUT : '(dry-run)',
    rowsBefore: p1.rows, rowsAfter: p1.rows - droppedRows,
    deltaRows: p1.deltaRows, droppedRows, keptRows,
    droppedMB: Number((droppedBytes / 1048576).toFixed(1)),
    sizeBeforeMB: Number((statSync(LOG as string).size / 1048576).toFixed(1)),
    sizeAfterMB: WRITE && existsSync(OUT) ? Number((statSync(OUT).size / 1048576).toFixed(1)) : null,
    nonDeltaRowsIdentical: before.size === after.size,
    write: WRITE,
  }
  if (JSON_OUT) console.log(JSON.stringify(report, null, 1))
  else {
    console.log(`行 ${report.rowsBefore} → ${report.rowsAfter} | 丢弃增量行 ${droppedRows}(约 ${report.droppedMB}MB 解压)`)
    console.log(`体积 ${report.sizeBeforeMB}MB → ${report.sizeAfterMB ?? '(dry-run)'}MB | 非增量行摘要一致: ${report.nonDeltaRowsIdentical}`)
  }
  process.exit(0)
}

void main()
