/**
 * @deepseek-ai/dsh-host-file-transfer — Web file-transfer seam.
 *
 * Registers three routes on the harness Web server so the GUI user can pull
 * workspace files into the browser and push browser files back into the
 * workspace without shell access:
 *
 *   GET  /api/file-transfer/           → minimal HTML page (list/download/upload)
 *   GET  /api/file-transfer/download?path=<root-relative>   → file download
 *   POST /api/file-transfer/upload?path=<root-relative>     → raw-body file write
 *
 * All paths are resolved against the configured `root` and must stay under it
 * (same traversal guard the frontend-static plugin uses). Method-less GET/HEAD
 * outside these routes is left to other owners.
 * @module @deepseek-ai/dsh-host-file-transfer
 */

import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'

/** Stable Cordis plugin name. */
export const name = 'file-transfer'
/** Required service: the effective Web server. */
export const inject = ['webServer']

/** Plugin config: the transfer root and whether the browse UI is mounted. */
export interface Config {
  /** Root directory every transfer path resolves against. */
  root: string
  /** Mount the minimal browse/upload HTML page. */
  ui: boolean
}

export const Config: z<Config> = z.object({
  root: z.string().default('/home/ubuntu/dsh-workshop'),
  ui: z.boolean().default(true),
})

/** Resolve a root-relative path and reject anything escaping the root. */
function resolveUnder(root: string, rel: string): string {
  const target = resolve(root, ...rel.split('/').filter(Boolean))
  if (target !== root && !target.startsWith(root + sep)) throw new RangeError('path escapes transfer root')
  return target
}
function bad(res: ServerResponse, code: number, message: string): void {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(message)
}

/** Read the request body (upload payload). */
function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        rejectBody(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks)))
    req.on('error', rejectBody)
  })
}

function fileUrlSafe(name: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
}

/** List one level of the root: name, kind, size (dirs first). */
async function listRoot(root: string): Promise<Array<Record<string, unknown>>> {
  const entries = await readdir(root)
  const out: Array<Record<string, unknown>> = []
  for (const entry of entries) {
    try {
      const s = await stat(resolve(root, entry))
      out.push({ name: entry, kind: s.isDirectory() ? 'dir' : 'file', size: s.size })
    } catch {
      /* vanished between readdir and stat */
    }
  }
  out.sort((a, b) => String(a.kind) === String(b.kind)
    ? String(a.name).localeCompare(String(b.name))
    : (String(a.kind) === 'dir' ? -1 : 1))
  return out
}

/** Minimal HTML surface: list root files, download by click, upload a file. */
function renderPage(): string {
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>DSH 文件传输</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:ui-sans-serif,system-ui,sans-serif;margin:2rem auto;max-width:760px;padding:0 1rem;color:#1a1a1a}
h1{font-size:1.3rem}.row{display:flex;justify-content:space-between;padding:.35rem 0;border-bottom:1px solid #eee}
a{color:#155eef;text-decoration:none}.muted{color:#888;font-size:.85rem}
.card{border:1px solid #ddd;border-radius:8px;padding:1rem;margin:1rem 0}
button{background:#155eef;color:#fff;border:0;border-radius:6px;padding:.45rem .9rem;cursor:pointer}
input[type=text]{width:60%;padding:.4rem;border:1px solid #ccc;border-radius:6px}
label{display:block;margin:.5rem 0;font-size:.9rem}</style></head><body>
<h1>DSH 文件传输</h1>
<p class="muted">路径均相对传输根目录（.. 越界会被拒绝）。</p>
<div class="card"><h3>下载</h3><div id="list">加载中…</div>
<p><label>或直接输入相对路径
<input type="text" id="dl" placeholder="novels/qizhongjiyi/drafts/0006.md"></label></p>
<button onclick="dl()">下载</button></div>
<div class="card"><h3>上传</h3>
<p><label>选择文件 <input type="file" id="f"></label></p>
<p><label>目标相对路径（默认=文件名）
<input type="text" id="up" placeholder="留空使用文件名"></label></p>
<button onclick="up()">上传</button> <span id="msg" class="muted"></span></div>
<script>
async function refresh(){const r=await fetch('list');const j=await r.json();
document.getElementById('list').innerHTML=(j.files||[]).map(x=>
 \`<div class="row"><span>\${x.kind==='dir'?'📁':'📄'} \${x.name}\${x.kind==='file'?' <span class="muted">'+(x.size||0)+' B</span>':''}</span>\${x.kind==='file'?'<a href="download?path='+encodeURIComponent(x.name)+'">下载</a>':'<span class="muted">目录</span>'}</div>\`).join('')||'<span class="muted">（空目录）</span>';}
function dl(){const p=document.getElementById('dl').value.trim();if(!p)return;
location.href='download?path='+encodeURIComponent(p);}
async function up(){const f=document.getElementById('f').files[0];if(!f){msg('先选文件');return;}
const p=(document.getElementById('up').value.trim())||f.name;
const r=await fetch('upload?path='+encodeURIComponent(p),{method:'POST',body:f});
msg((r.ok?'已上传 ':'失败 ')+p+' ('+r.status+')');if(r.ok)refresh();}
function msg(t){document.getElementById('msg').textContent=t;}
refresh();
</script></body></html>`
}

/** Register the three routes for the lifetime of the plugin. */
export function apply(ctx: Context, config: Config): void {
  const root = config.root
  const base = '/api/file-transfer'
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: base,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const route = url.pathname.slice(base.length) || '/'
      try {
        if (route === '/' || route === '/ui') {
          if (config.ui && req.method === 'GET') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
            res.end(renderPage())
            return
          }
          bad(res, 404, 'not found')
          return
        }
        if (route === '/list') {
          if (req.method !== 'GET') { bad(res, 405, 'GET only'); return }
          const files = await listRoot(root)
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ root, files }))
          return
        }
        if (route === '/download') {
          if (req.method !== 'GET' && req.method !== 'HEAD') { bad(res, 405, 'GET only'); return }
          const rel = url.searchParams.get('path') ?? ''
          let target: string
          try { target = resolveUnder(root, rel) } catch { bad(res, 403, 'path escapes transfer root'); return }
          try {
            const s = await stat(target)
            if (!s.isFile()) { bad(res, 404, 'not a file'); return }
            const name = rel.split('/').pop() ?? 'file'
            res.writeHead(200, {
              'content-type': 'application/octet-stream',
              'content-length': String(s.size),
              'content-disposition': fileUrlSafe(name),
            })
            if (req.method === 'HEAD') { res.end(); return }
            res.end(await readFile(target))
          } catch {
            bad(res, 404, 'no such file')
          }
          return
        }
        if (route === '/upload') {
          if (req.method !== 'POST') { bad(res, 405, 'POST only'); return }
          const rel = url.searchParams.get('path') ?? ''
          let target: string
          try { target = resolveUnder(root, rel) } catch { bad(res, 403, 'path escapes transfer root'); return }
          try {
            const body = await readBody(req)
            await mkdir(dirname(target), { recursive: true })
            await writeFile(target, body)
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('ok')
          } catch (error) {
            bad(res, 400, error instanceof Error ? error.message : 'upload failed')
          }
          return
        }
        bad(res, 404, 'not found')
      } catch (error) {
        bad(res, 500, error instanceof Error ? error.message : 'internal error')
      }
    },
  }), 'file-transfer routes')
}
