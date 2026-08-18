#!/usr/bin/env node
// dsh-web-gateway — 有限对象访问 DSH Web 的鉴权网关
//
// 作用：把"谁能访问 DSH Web"收窄为一份白名单（tokens.json），
//       其余请求一律 401。HTTP 与 WebSocket(Upgrade) 都转发到本机 DSH Web。
//
// 安全设计：
//   * 默认只绑 127.0.0.1（GATEWAY_HOST）。远程对象可达需显式改为 0.0.0.0，
//     并配合防火墙只放行信任来源 / SSH 隧道 / Tailscale——见 README。
//   * 每个"有限对象"一个 token（长随机串），访问时带 X-Access-Token 头
//     或 ?token= 查询参数；网关记录每次访问日志用于审计。
//
// 运行：node gateway.mjs

import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))

// 默认回环：安全默认。远程对象要连进来时显式设置 GATEWAY_HOST=0.0.0.0，
// 然后用防火墙/隧道把可达范围收窄到信任来源（README「部署与安全」）。
const GATEWAY_HOST = process.env.GATEWAY_HOST ?? '127.0.0.1'
const GATEWAY_PORT = Number(process.env.GATEWAY_PORT ?? 4080)
// DSH Web 目标（本机 GUI 默认 127.0.0.1:3080）
const TARGET = process.env.DSH_WEB_TARGET ?? 'http://127.0.0.1:3080'
const TOKENS_FILE = process.env.GATEWAY_TOKENS ?? path.join(DIR, 'tokens.json')

// tokens.json: { "<token>": "对象名" }
let tokens = {}

async function loadTokens() {
  try {
    const raw = await fs.readFile(TOKENS_FILE, 'utf8')
    tokens = JSON.parse(raw)
  } catch (error) {
    console.error(`无法读取 ${TOKENS_FILE}: ${error.message}`)
    console.error('文件形如 { "<token>": "对象名" }，可用 openssl rand -hex 24 生成 token')
    process.exit(1)
  }
}

function authorize(req) {
  const header = req.headers['x-access-token']
  const queryToken = new URL(req.url ?? '/', `http://${req.headers.host ?? 'gw'}`).searchParams.get('token')
  const token = typeof header === 'string' && header !== '' ? header : queryToken
  if (!token) return null
  return tokens[token] ?? null
}

function log(identity, method, target, status) {
  const ts = new Date().toISOString()
  console.log(`[${ts}] ${identity ?? 'UNAUTHORIZED'} ${method} ${target} -> ${status}`)
}

function writeJson(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(text)
}

const server = http.createServer((req, res) => {
  const identity = authorize(req)
  if (!identity) {
    log(null, req.method, req.url, 401)
    return writeJson(res, 401, 'unauthorized: missing or invalid access token')
  }
  const target = new URL(TARGET)
  const proxyReq = http.request({
    hostname: target.hostname,
    port: target.port,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: target.host },
  }, proxyRes => {
    res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers)
    proxyRes.pipe(res)
    log(identity, req.method, req.url, proxyRes.statusCode ?? 502)
  })
  proxyReq.on('error', err => {
    log(identity, req.method, req.url, 502)
    writeJson(res, 502, `bad gateway: ${err.message}`)
  })
  req.pipe(proxyReq)
})

// WebSocket / SSE 的 Upgrade 转发（DSH Web 的实时通道）
server.on('upgrade', (req, socket, head) => {
  const identity = authorize(req)
  if (!identity) {
    log(null, 'UPGRADE', req.url, 401)
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }
  if (head && head.length > 0) socket.unshift(head)
  const target = new URL(TARGET)
  const proxyReq = http.request({
    hostname: target.hostname,
    port: target.port,
    path: req.url,
    headers: { ...req.headers, host: target.host },
  })
  proxyReq.on('upgrade', (upRes, upSocket, upHead) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\n')
    socket.write(`Upgrade: ${upRes.headers.upgrade ?? 'websocket'}\r\n`)
    socket.write('Connection: Upgrade\r\n')
    if (upRes.headers['sec-websocket-accept']) {
      socket.write(`Sec-WebSocket-Accept: ${upRes.headers['sec-websocket-accept']}\r\n`)
    }
    socket.write('\r\n')
    if (upHead && upHead.length > 0) upSocket.unshift(upHead)
    upSocket.pipe(socket)
    socket.pipe(upSocket)
    log(identity, 'UPGRADE', req.url, 101)
  })
  proxyReq.on('error', () => socket.destroy())
  proxyReq.end()
})

server.listen(GATEWAY_PORT, GATEWAY_HOST, async () => {
  await loadTokens()
  console.log(`dsh-web-gateway 已启动: ${GATEWAY_HOST}:${GATEWAY_PORT} -> ${TARGET}`)
  console.log(`白名单对象(${Object.keys(tokens).length}): ${Object.values(tokens).join('、') || '（空，请先编辑 tokens.json）'}`)
  console.log('默认只绑回环；远程对象可达请设 GATEWAY_HOST=0.0.0.0 并用防火墙/隧道收窄（README）。')
})
