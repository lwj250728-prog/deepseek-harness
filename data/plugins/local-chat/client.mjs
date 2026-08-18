#!/usr/bin/env node
// local-chat client — 命令行聊天客户端（零依赖，仅 Node 内置模块）
//
// 运行：node client.mjs [host] [port]   （默认 127.0.0.1:8765）
//
// 命令：
//   /register <用户名> <密码>       注册
//   /login    <用户名> <密码>       登录（登录后自动补收离线消息）
//   /logout                         退出登录
//   /msg <用户> <文本>              私聊
//   /creategroup <群名> [成员1,成员2...]  建群（逗号分隔，不含自己）
//   /join <群id>                    加群
//   /leave <群id>                   退群
//   /gmsg <群id> <文本>             群聊
//   /groups                         我的群列表
//   /members <群id>                 群成员
//   /users                          所有用户与在线状态
//   /quit                           退出客户端

import net from 'node:net'
import readline from 'node:readline'

const HOST = process.argv[2] ?? '127.0.0.1'
const PORT = Number(process.argv[3] ?? process.env.CHAT_PORT ?? 8765)

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false })

function usage() {
  console.log(`
命令：
  /register <用户名> <密码>
  /login    <用户名> <密码>
  /logout
  /msg <用户> <文本>
  /creategroup <群名> [成员1,成员2...]
  /join <群id>
  /leave <群id>
  /gmsg <群id> <文本>
  /groups
  /members <群id>
  /users
  /quit
`)
}

const sock = net.createConnection({ host: HOST, port: PORT }, () => {
  console.log(`已连接 ${HOST}:${PORT}，输入 /help 查看命令`)
})

function send(obj) {
  if (sock.destroyed) {
    console.log('[连接已断开]')
    return
  }
  sock.write(`${JSON.stringify(obj)}\n`)
}

function fmtTime(ts) {
  const d = new Date(ts)
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

sock.on('data', chunk => {
  for (const line of chunk.toString('utf8').split('\n')) {
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    switch (msg.type) {
      case 'msg':
        if (msg.kind === 'dm') {
          console.log(`[${fmtTime(msg.ts)}] ${msg.from} -> 我: ${msg.text}`)
        } else {
          console.log(`[${fmtTime(msg.ts)}] [群:${msg.groupName}] ${msg.from}: ${msg.text}`)
        }
        break
      case 'sys':
        console.log(`[系统] [群:${msg.groupName}] ${msg.text}`)
        break
      case 'presence':
        console.log(`[状态] ${msg.username} ${msg.online ? '上线' : '下线'}`)
        break
      case 'ok':
        console.log(`[OK] ${msg.message}${msg.gid ? ` (群id: ${msg.gid})` : ''}`)
        if (msg.username) console.log('（已登录，离线消息已补收）')
        if (msg.groups) {
          for (const g of msg.groups) console.log(`  ${g.gid}  ${g.name}  (${g.members}人, 群主:${g.owner})`)
        }
        if (msg.users) {
          for (const u of msg.users) console.log(`  ${u.username}  ${u.online ? '● 在线' : '○ 离线'}`)
        }
        if (msg.members) {
          console.log(`  群 ${msg.name}: ${msg.members.join(', ')} (群主: ${msg.owner})`)
        }
        break
      case 'error':
        console.log(`[错误] ${msg.message}`)
        break
      case 'pong':
        break
      default:
        console.log(`[未知] ${JSON.stringify(msg)}`)
    }
  }
})

sock.on('close', () => {
  console.log('连接已关闭')
  process.exit(0)
})

sock.on('error', err => {
  console.error(`连接失败: ${err.message}`)
  process.exit(1)
})

rl.on('line', line => {
  const text = line.trim()
  if (!text) return
  if (text === '/help' || text === 'help') return usage()
  if (text === '/quit' || text === 'quit') {
    sock.end()
    return
  }

  const [cmd, ...rest] = text.split(/\s+/)
  const arg = rest.join(' ')

  switch (cmd) {
    case '/register': {
      const [name, pass] = rest
      if (!name || !pass) return console.log('用法: /register <用户名> <密码>')
      return send({ type: 'register', username: name, password: pass })
    }
    case '/login': {
      const [name, pass] = rest
      if (!name || !pass) return console.log('用法: /login <用户名> <密码>')
      return send({ type: 'login', username: name, password: pass })
    }
    case '/logout':
      return send({ type: 'logout' })
    case '/msg': {
      const [to, ...textParts] = rest
      if (!to || textParts.length === 0) return console.log('用法: /msg <用户> <文本>')
      return send({ type: 'dm', to, text: textParts.join(' ') })
    }
    case '/creategroup': {
      const idx = arg.indexOf(' ')
      if (idx < 0) return console.log('用法: /creategroup <群名> [成员1,成员2...]')
      const name = arg.slice(0, idx).trim()
      const members = arg.slice(idx + 1).split(',').map(s => s.trim()).filter(Boolean)
      return send({ type: 'create_group', name, members })
    }
    case '/join': {
      const gid = rest[0]
      if (!gid) return console.log('用法: /join <群id>')
      return send({ type: 'join_group', gid })
    }
    case '/leave': {
      const gid = rest[0]
      if (!gid) return console.log('用法: /leave <群id>')
      return send({ type: 'leave_group', gid })
    }
    case '/gmsg': {
      const [gid, ...textParts] = rest
      if (!gid || textParts.length === 0) return console.log('用法: /gmsg <群id> <文本>')
      return send({ type: 'group_msg', gid, text: textParts.join(' ') })
    }
    case '/groups':
      return send({ type: 'list_groups' })
    case '/members': {
      const gid = rest[0]
      if (!gid) return console.log('用法: /members <群id>')
      return send({ type: 'group_members', gid })
    }
    case '/users':
      return send({ type: 'list_users' })
    default:
      console.log(`未知命令: ${cmd}（/help 查看）`)
  }
})
