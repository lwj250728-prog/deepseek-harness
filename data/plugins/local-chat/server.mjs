#!/usr/bin/env node
// local-chat server — 本机回环聊天服务（零依赖，仅 Node 内置模块）
//
// 安全设计：
//   * 只绑定 127.0.0.1，不暴露任何公网端点（用户要求"避免 web 部署公网被攻击"）
//   * 密码 scrypt 哈希 + 随机 token 认证
//   * 如需远程访问，用 SSH 隧道（见 README），不要改成 0.0.0.0
//
// 协议：TCP + NDJSON（每行一个 JSON 对象，\n 分帧）
// 存储：<dataDir>/{users.json,groups.json,dm/*.jsonl,group/*.jsonl}
//
// 运行：node server.mjs [port]

import net from 'node:net'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(_scrypt)

// 默认只绑回环，无公网攻击面。
// 远程手机访问两种方式（README「远程手机使用」）：
//   A. SSH 隧道（推荐）：保持 127.0.0.1 不变，手机 SSH 客户端做 -L 转发；
//   B. 虚拟局域网（Tailscale/ZeroTier）：把 CHAT_HOST 设为虚拟网卡 IP（如 100.x.x.x），
//      靠虚拟网 ACL 收窄访问。绝不要设为 0.0.0.0 或做公网端口转发。
const HOST = process.env.CHAT_HOST ?? '127.0.0.1'
const PORT = Number(process.argv[2] ?? process.env.CHAT_PORT ?? 8765)
const DATA_DIR = process.env.CHAT_DATA ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'data')

const USERS_FILE = path.join(DATA_DIR, 'users.json')
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json')
const DM_DIR = path.join(DATA_DIR, 'dm')
const GROUP_DIR = path.join(DATA_DIR, 'group')

// ── 存储层 ────────────────────────────────────────────────────────────────

async function ensureDirs() {
  await fs.mkdir(DM_DIR, { recursive: true })
  await fs.mkdir(GROUP_DIR, { recursive: true })
}

async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, 'utf8')
    return raw.trim() === '' ? fallback : JSON.parse(raw)
  } catch {
    return fallback
  }
}

async function writeJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value, null, 2))
}

// users: { [username]: { salt, hash, createdAt } }
// groups: { [gid]: { name, owner, members: [], createdAt } }
let users = {}
let groups = {}

async function loadState() {
  users = await readJson(USERS_FILE, {})
  groups = await readJson(GROUPS_FILE, {})
}

async function saveUsers() { await writeJson(USERS_FILE, users) }
async function saveGroups() { await writeJson(GROUPS_FILE, groups) }

function dmFile(a, b) {
  const key = [a, b].sort().join('__')
  return path.join(DM_DIR, `${key}.jsonl`)
}

function groupFile(gid) {
  return path.join(GROUP_DIR, `${gid}.jsonl`)
}

async function appendLine(file, obj) {
  await fs.appendFile(file, `${JSON.stringify(obj)}\n`)
}

async function readLines(file) {
  try {
    const raw = await fs.readFile(file, 'utf8')
    return raw.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
  } catch {
    return []
  }
}

// ── 认证 ──────────────────────────────────────────────────────────────────

async function hashPassword(password, salt) {
  const buf = await scrypt(password, salt, 64)
  return buf.toString('hex')
}

function safeEqual(a, b) {
  const ba = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

const sessions = new Map() // token -> username（Web UI 的 SSE 认证用）

function issueToken(username) {
  const token = randomBytes(24).toString('hex')
  sessions.set(token, username)
  return token
}

// ── 在线与推送 ────────────────────────────────────────────────────────────

const online = new Map() // username -> Set<socket>
const lastSeenByUser = new Map() // username -> 上次下线时刻（离线补推游标）

function send(socket, obj) {
  if (socket.destroyed) return
  socket.write(`${JSON.stringify(obj)}\n`)
}

function isOnline(username) {
  return online.has(username) && online.get(username).size > 0
}

function pushToUser(username, obj) {
  const set = online.get(username)
  if (!set) return
  for (const sock of set) send(sock, obj)
}

// 上下线广播：推给除本人外的所有在线用户
function broadcastPresence(username, onlineState) {
  for (const [u, set] of online) {
    if (u === username) continue
    for (const sock of set) send(sock, { type: 'presence', username, online: onlineState })
  }
}

// 记录某用户的下线时刻（作为其离线补推的游标）
function markOffline(username) {
  lastSeenByUser.set(username, Date.now())
}

// ── 命令处理 ──────────────────────────────────────────────────────────────

// 每个 socket 维护：{ user: username|null }
async function handleMessage(sock, msg) {
  const { type } = msg
  if (type === 'register') return doRegister(sock, msg)
  if (type === 'login') return doLogin(sock, msg)
  if (type === 'logout') return doLogout(sock)
  if (!sock.user) {
    return send(sock, { type: 'error', message: '未登录：请先 /login 或 /register' })
  }
  switch (type) {
    case 'dm': return doDm(sock, msg)
    case 'create_group': return doCreateGroup(sock, msg)
    case 'join_group': return doJoinGroup(sock, msg)
    case 'leave_group': return doLeaveGroup(sock, msg)
    case 'group_msg': return doGroupMsg(sock, msg)
    case 'list_groups': return doListGroups(sock)
    case 'group_members': return doGroupMembers(sock, msg)
    case 'list_users': return doListUsers(sock)
    case 'ping': return send(sock, { type: 'pong', ts: Date.now() })
    default:
      return send(sock, { type: 'error', message: `未知命令: ${type}` })
  }
}

async function doRegister(sock, { username, password }) {
  const name = String(username ?? '').trim()
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{1,32}$/.test(name)) {
    return send(sock, { type: 'error', message: '用户名须为 1-32 位字母/数字/下划线/中文' })
  }
  if (typeof password !== 'string' || password.length < 4) {
    return send(sock, { type: 'error', message: '密码至少 4 位' })
  }
  if (users[name]) {
    return send(sock, { type: 'error', message: '用户名已存在' })
  }
  const salt = randomBytes(16).toString('hex')
  const hash = await hashPassword(password, salt)
  users[name] = { salt, hash, createdAt: Date.now() }
  await saveUsers()
  return send(sock, { type: 'ok', message: '注册成功，请登录' })
}

async function doLogin(sock, { username, password }) {
  const name = String(username ?? '').trim()
  const user = users[name]
  if (!user || typeof password !== 'string') {
    return send(sock, { type: 'error', message: '用户名或密码错误' })
  }
  const hash = await hashPassword(password, user.salt)
  if (!safeEqual(hash, user.hash)) {
    return send(sock, { type: 'error', message: '用户名或密码错误' })
  }
  // 离线补推游标 = 上次下线时刻；首次登录为 0（全量补推历史私聊/群消息）
  const since = lastSeenByUser.get(name) ?? 0
  sock.user = name
  if (!online.has(name)) online.set(name, new Set())
  online.get(name).add(sock)
  const token = issueToken(name)
  send(sock, { type: 'ok', message: `欢迎回来，${name}`, username: name, token })
  await flushOffline(sock, name, since)
  return broadcastPresence(name, true)
}

// 公共断开清理：记录下线时刻、移出在线表、广播下线
function detachSocket(sock) {
  if (!sock.user) return
  markOffline(sock.user)
  const set = online.get(sock.user)
  set?.delete(sock)
  if (set && set.size === 0) {
    online.delete(sock.user)
    broadcastPresence(sock.user, false)
  }
}

function doLogout(sock) {
  detachSocket(sock)
  sock.user = null
  return send(sock, { type: 'ok', message: '已退出登录' })
}

// 离线消息：推送 lastSeen 之后、且不是自己发来的私聊/群消息
async function flushOffline(sock, username, since) {
  // 私聊：扫描所有可能涉及该用户的 dm 文件（遍历目录）
  const dir = await fs.readdir(DM_DIR).catch(() => [])
  for (const file of dir) {
    if (!file.endsWith('.jsonl')) continue
    const key = file.replace(/\.jsonl$/, '')
    const [a, b] = key.split('__')
    if (a !== username && b !== username) continue
    const lines = await readLines(path.join(DM_DIR, file))
    for (const line of lines) {
      if (line.from !== username && line.ts > since) {
        send(sock, { type: 'msg', kind: 'dm', from: line.from, to: username, text: line.text, ts: line.ts })
      }
    }
  }
  // 群：所属各群的新消息
  for (const [gid, g] of Object.entries(groups)) {
    if (!g.members.includes(username)) continue
    const lines = await readLines(groupFile(gid))
    for (const line of lines) {
      if (line.from !== username && line.ts > since) {
        send(sock, { type: 'msg', kind: 'group', gid, groupName: g.name, from: line.from, text: line.text, ts: line.ts })
      }
    }
  }
}

async function doDm(sock, { to, text }) {
  const target = String(to ?? '').trim()
  if (!target || target === sock.user) {
    return send(sock, { type: 'error', message: '私聊对象无效' })
  }
  if (!users[target]) {
    return send(sock, { type: 'error', message: `用户 ${target} 不存在` })
  }
  const content = String(text ?? '').trim()
  if (!content) return send(sock, { type: 'error', message: '消息不能为空' })
  if (content.length > 4000) return send(sock, { type: 'error', message: '消息过长（≤4000 字符）' })
  const rec = { kind: 'dm', from: sock.user, to: target, text: content, ts: Date.now() }
  await appendLine(dmFile(sock.user, target), rec)
  if (isOnline(target)) {
    pushToUser(target, { type: 'msg', kind: 'dm', from: sock.user, to: target, text: content, ts: rec.ts })
  }
  return send(sock, { type: 'ok', message: '已发送' })
}

async function doCreateGroup(sock, { name, members }) {
  const groupName = String(name ?? '').trim()
  if (!groupName) return send(sock, { type: 'error', message: '群名不能为空' })
  if (groupName.length > 32) return send(sock, { type: 'error', message: '群名过长（≤32 字符）' })
  const list = Array.isArray(members) ? members : []
  const memberSet = new Set([sock.user, ...list.map(String).map(s => s.trim()).filter(Boolean)])
  for (const m of memberSet) {
    if (!users[m]) return send(sock, { type: 'error', message: `成员 ${m} 不存在` })
  }
  const gid = randomBytes(4).toString('hex')
  groups[gid] = { name: groupName, owner: sock.user, members: [...memberSet], createdAt: Date.now() }
  await saveGroups()
  return send(sock, { type: 'ok', message: '群已创建', gid, members: [...memberSet] })
}

async function doJoinGroup(sock, { gid }) {
  const g = groups[String(gid ?? '')]
  if (!g) return send(sock, { type: 'error', message: '群不存在' })
  if (g.members.includes(sock.user)) return send(sock, { type: 'error', message: '已在群中' })
  g.members.push(sock.user)
  await saveGroups()
  send(sock, { type: 'ok', message: `已加入群 ${g.name}` })
  return pushToGroup(gid, { type: 'sys', gid, groupName: g.name, text: `${sock.user} 加入了群聊` })
}

async function doLeaveGroup(sock, { gid }) {
  const g = groups[String(gid ?? '')]
  if (!g) return send(sock, { type: 'error', message: '群不存在' })
  if (!g.members.includes(sock.user)) return send(sock, { type: 'error', message: '不在群中' })
  g.members = g.members.filter(m => m !== sock.user)
  if (g.members.length === 0) {
    delete groups[gid]
    await saveGroups()
    return send(sock, { type: 'ok', message: '已退群（群已解散）' })
  }
  if (g.owner === sock.user) g.owner = g.members[0]
  await saveGroups()
  send(sock, { type: 'ok', message: `已退出群 ${g.name}` })
  return pushToGroup(gid, { type: 'sys', gid, groupName: g.name, text: `${sock.user} 退出了群聊` })
}

function pushToGroup(gid, obj) {
  const g = groups[gid]
  if (!g) return
  for (const m of g.members) {
    if (isOnline(m)) pushToUser(m, { ...obj, gid, groupName: g.name })
  }
}

async function doGroupMsg(sock, { gid, text }) {
  const g = groups[String(gid ?? '')]
  if (!g) return send(sock, { type: 'error', message: '群不存在' })
  if (!g.members.includes(sock.user)) return send(sock, { type: 'error', message: '不是群成员' })
  const content = String(text ?? '').trim()
  if (!content) return send(sock, { type: 'error', message: '消息不能为空' })
  if (content.length > 4000) return send(sock, { type: 'error', message: '消息过长（≤4000 字符）' })
  const rec = { kind: 'group', gid, from: sock.user, text: content, ts: Date.now() }
  await appendLine(groupFile(gid), rec)
  pushToGroup(gid, { type: 'msg', kind: 'group', gid, groupName: g.name, from: sock.user, text: content, ts: rec.ts })
  return send(sock, { type: 'ok', message: '已发送到群' })
}

function doListGroups(sock) {
  const mine = Object.entries(groups)
    .filter(([, g]) => g.members.includes(sock.user))
    .map(([gid, g]) => ({ gid, name: g.name, owner: g.owner, members: g.members.length }))
  return send(sock, { type: 'ok', groups: mine })
}

function doGroupMembers(sock, { gid }) {
  const g = groups[String(gid ?? '')]
  if (!g) return send(sock, { type: 'error', message: '群不存在' })
  return send(sock, { type: 'ok', gid, name: g.name, owner: g.owner, members: g.members })
}

function doListUsers(sock) {
  const names = Object.keys(users)
  const onlineUsers = [...online.keys()]
  return send(sock, { type: 'ok', users: names.map(n => ({ username: n, online: onlineUsers.includes(n) })) })
}

// ── 连接生命周期 ──────────────────────────────────────────────────────────

function handleConnection(sock) {
  sock.user = null
  let buffer = ''

  sock.on('data', chunk => {
    buffer += chunk.toString('utf8')
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch {
        send(sock, { type: 'error', message: '无效的 JSON 帧' })
        continue
      }
      handleMessage(sock, msg).catch(err => {
        send(sock, { type: 'error', message: `服务器错误: ${err.message}` })
      })
    }
  })

  sock.on('error', () => {})
  sock.on('close', () => {
    detachSocket(sock)
  })
}

// ── Web UI（HTTP + SSE，仍只绑 127.0.0.1，不暴露公网）──────────────────

const HTTP_PORT = Number(process.env.CHAT_HTTP_PORT ?? 8080)
let uiHtml = null

async function loadUi() {
  uiHtml = await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui.html'), 'utf8')
}

// 一次性响应 socket：把 handleMessage 的第一条输出作为 HTTP JSON 响应
function echoSocket(res) {
  const sock = { user: null, destroyed: false }
  sock.write = obj => {
    if (sock.destroyed || res.writableEnded) return
    sock.destroyed = true
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }
  return sock
}

// 带 token 的命令 socket：以 token 对应用户身份执行（user 预设，跳过登录检查）
function commandSocket(username, res) {
  const sock = { user: username, destroyed: false }
  sock.write = obj => {
    if (sock.destroyed || res.writableEnded) return
    sock.destroyed = true
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }
  return sock
}

// SSE socket：write 转成 EventSource 推送；close 时走公共清理
function sseSocket(username, res) {
  const sock = { user: username, destroyed: false }
  sock.write = obj => {
    if (sock.destroyed || res.writableEnded) return
    res.write(`data: ${JSON.stringify(obj)}\n\n`)
  }
  return sock
}

async function handleHttp(req, res) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(uiHtml)
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    const username = sessions.get(url.searchParams.get('token') ?? '')
    if (!username) {
      res.writeHead(401)
      return res.end('unauthorized')
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.write('retry: 3000\n\n')
    const sock = sseSocket(username, res)
    if (!online.has(username)) online.set(username, new Set())
    online.get(username).add(sock)
    const since = lastSeenByUser.get(username) ?? 0
    // 该连接的离线消息补推（登录接口的补推打在一次性的 echo socket 上会丢弃，SSE 才是真正的送达通道）
    flushOffline(sock, username, since).catch(() => {})
    res.on('close', () => {
      sock.destroyed = true
      detachSocket(sock)
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api') {
    let body = ''
    req.on('data', chunk => {
      body += chunk
      if (body.length > 64 * 1024) req.destroy()
    })
    req.on('end', async () => {
      let msg
      try { msg = JSON.parse(body) } catch {
        res.writeHead(400)
        return res.end('bad json')
      }
      try {
        if (msg.type === 'register' || msg.type === 'login') {
          return await handleMessage(echoSocket(res), msg)
        }
        const username = sessions.get(String(msg.token ?? ''))
        if (!username) {
          res.writeHead(401)
          return res.end('unauthorized')
        }
        delete msg.token
        return await handleMessage(commandSocket(username, res), msg)
      } catch (err) {
        const sock = echoSocket(res)
        return sock.write({ type: 'error', message: `服务器错误: ${err.message}` })
      }
    })
    return
  }

  res.writeHead(404)
  res.end('not found')
}

// ── 启动 ──────────────────────────────────────────────────────────────────

async function main() {
  await ensureDirs()
  await loadState()
  await loadUi()
  const server = net.createServer(handleConnection)
  server.listen(PORT, HOST, () => {
    console.log(`local-chat TCP 已启动: ${HOST}:${PORT}`)
    console.log(`local-chat Web UI 已启动: http://${HOST}:${HTTP_PORT}`)
    console.log(`数据目录: ${DATA_DIR}`)
    console.log('仅绑定回环地址，无公网攻击面。远程访问请用 SSH 隧道（README）。')
  })
  server.on('error', err => {
    console.error(`服务器启动失败: ${err.message}`)
    process.exit(1)
  })
  const web = http.createServer(handleHttp)
  web.listen(HTTP_PORT, HOST, () => {
    console.log(`Web UI 监听 ${HOST}:${HTTP_PORT}`)
  })
  web.on('error', err => {
    console.error(`Web UI 启动失败: ${err.message}`)
    process.exit(1)
  })
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
