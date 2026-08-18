# local-chat — 本机回环聊天服务（零依赖）

一个**不暴露公网**的单对单 + 群聊聊天软件。纯 Node 内置模块（`node:net`/`node:crypto`/`node:fs`），
无任何 npm 依赖，`node` 直接运行。

## 为什么这样设计（安全）

- **只绑定 `127.0.0.1`**：没有公网监听端口，不存在被公网扫描/攻击的暴露面（对应"避免使用 web 部署公网被攻击"）。
- **密码 scrypt 哈希**存储，登录发随机 token。
- 远程访问请用 **SSH 隧道**（见下文），而不是把监听地址改成 `0.0.0.0`。

## 快速开始

```sh
# 终端 1：启动服务端（TCP 8765 + Web UI 8080，都只绑 127.0.0.1）
node server.mjs
```

### 方式 A：Web UI（浏览器，推荐）

打开 **http://127.0.0.1:8080** —— 图形界面：登录/注册、用户列表、我的群、消息气泡、
建群/加群弹窗、实时推送（SSE）。发送消息同样支持 `/msg <用户> <文本>` 与 `/gmsg <群id> <文本>` 语法。

### 方式 B：CLI 客户端

```sh
# 终端 2、3：开两个客户端模拟两个用户
node client.mjs
```

两个客户端分别：

```text
# 用户 A
/register alice 密码1234
/login alice 密码1234

# 用户 B
/register bob 密码5678
/login bob 密码5678
/msg alice 你好，我是 bob        # 私聊
/creategroup 技术讨论组 bob      # 建群（自动把创建者拉入）
/join 3f2a1b9c                  # 加群（用 /groups 查群id）
/gmsg 3f2a1b9c 大家好            # 群聊
/groups /members 3f2a1b9c /users
```

## 命令速查

| 命令 | 说明 |
|---|---|
| `/register <用户名> <密码>` | 注册（用户名：1-32 位字母/数字/下划线/中文） |
| `/login <用户名> <密码>` | 登录（自动补收离线消息） |
| `/logout` | 退出登录 |
| `/msg <用户> <文本>` | 单对单私聊（对方在线实时送达，离线则登录后补收） |
| `/creategroup <群名> [成员1,成员2...]` | 建群（创建者自动入群） |
| `/join <群id>` / `/leave <群id>` | 加群 / 退群（退到空群自动解散） |
| `/gmsg <群id> <文本>` | 群聊（仅群成员可发可收） |
| `/groups` / `/members <群id>` / `/users` | 群列表 / 群成员 / 用户与在线状态 |
| `/quit` | 退出客户端 |

## 存储布局（`CHAT_DATA` 或脚本同目录 `data/`）

```
data/
  users.json          # 用户表（salt + scrypt hash，绝不存明文密码）
  groups.json         # 群表（gid → 名称/群主/成员）
  dm/<a>__<b>.jsonl   # 私聊消息（按用户对分文件，NDJSON 追加）
  group/<gid>.jsonl   # 群消息（NDJSON 追加）
```

- 消息持久化在磁盘，服务端重启不丢。
- 离线消息：登录时按 `lastSeen` 补推未读的私聊与群消息。

## 远程手机使用（不暴露公网）

服务默认只绑 `127.0.0.1`。手机要远程访问，用**隧道/虚拟组网**把它"接进"回环，而不是开公网端口。

### 方式 A：SSH 隧道（推荐，零暴露）

1. 电脑开启 SSH 服务：Windows「设置 → 应用 → 可选功能 → 添加 *OpenSSH 服务器*」，管理员 PowerShell 执行 `net start sshd`。
2. 手机装 SSH 客户端：**[Termius](https://termius.com)**（iOS/Android，免费版够用）、JuiceSSH（Android）、Termux（Android，`pkg install openssh`）。
3. 手机与电脑同一 WiFi 时，在手机 SSH 客户端配置**本地端口转发**（或 Termux 命令行）：
   ```sh
   ssh -L 8080:127.0.0.1:8080 用户名@电脑局域网IP
   ```
4. 手机浏览器打开 `http://127.0.0.1:8080` —— 手机的 8080 经加密隧道直达电脑，全程无公网暴露。

### 方式 B：虚拟局域网（异地可用，次选）

1. 电脑与手机都装 **[Tailscale](https://tailscale.com)**（免费，WireGuard 加密），登录同一账号。
2. 电脑 `ipconfig` 查 Tailscale 网卡 IP（如 `100.64.x.x`）。
3. 以该 IP 启动服务（**不要用 0.0.0.0**）：
   ```sh
   # Windows
   set CHAT_HOST=100.64.x.x && node server.mjs
   # macOS/Linux
   CHAT_HOST=100.64.x.x node server.mjs
   ```
4. 手机浏览器访问 `http://100.64.x.x:8080`；再到 Tailscale 管理后台把 ACL 收窄为仅放行手机的该端口访问。

> 注意：方式 B 的监听地址不再是回环，暴露面靠 Tailscale 网络隔离兜底。

### 明确不推荐：公网端口转发

路由器 NAT 转发 + DDNS 会让服务暴露在公网——正是本设计要避免的攻击面，别做。

### 手机端小提示

- 窄屏下侧栏自动隐藏，聊天区全宽；输入框 16px 防 iOS 聚焦缩放。
- 群操作走命令：`/msg <用户> <文本>`、`/gmsg <群id> <文本>`、`/groups` 查群 id、`/users` 看在线。

## 环境变量 / 参数

| 项 | 默认 | 说明 |
|---|---|---|
| `CHAT_PORT` 或第 1 个参数 | `8765` | TCP 端口（CLI 用，仍只绑 127.0.0.1） |
| `CHAT_HTTP_PORT` | `8080` | Web UI 端口（仍只绑 127.0.0.1） |
| `CHAT_DATA` | 脚本同目录 `data/` | 数据目录 |
| `node client.mjs [host] [port]` | `127.0.0.1:8765` | 客户端连接目标 |

## 安全须知

1. **不要**把 `HOST` 改成 `0.0.0.0` 或加公网端口转发——那正是本设计要避免的暴露面。Web UI 与 TCP 一样只绑回环。
2. 远程使用：`ssh -L 8765:127.0.0.1:8765 -L 8080:127.0.0.1:8080 用户@远程机`，然后本地访问 `127.0.0.1:8080`。
3. 用户名含**连续下划线**（如 `a__b`）会与私聊文件名编码冲突，请避免。
4. 这是演示级实现：Web 端认证为内存 token（服务端重启即失效）、未做消息加密（本地回环可信）、未做踢人/群主转让/已读回执——需要再补。

## 局限与下一步（可选）

- 未实现：踢人/禁言/群公告/消息历史分页/文件传输/已读。
- **DSH 桥接方向**：把 `msg` 事件桥进 DSH agent 会话——在 `server.mjs` 收到 `dm` 时调用
  `agent.followup(createUserMessage(...))` 并把 agent 输出回发，即可让聊天里的对话驱动 DSH 智能体；
  按 `<dshHome>/profiles/<name>/cordis.patch.yml` 的 `insert` 方式包装为插件即可。
