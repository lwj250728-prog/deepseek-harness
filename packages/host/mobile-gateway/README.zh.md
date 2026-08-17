# @deepseek-ai/dsh-mobile-gateway

[English](README.md) | 中文

**手机访问 DSH Web 的鉴权网关插件 + App**：一个带白名单令牌鉴权的反向代理（HTTP + WebSocket），让**指定的手机用户**能直接通过手机使用 DSH Web GUI。作为 Cordis 插件运行在 `dsh --profile web` 进程**内部**（也可用 `node lib/standalone.js` 独立运行），并附带手机端登录页、PWA（可安装为 App）和 Android WebView 工程。

```
手机浏览器/App ──► 网关(0.0.0.0:4080, 令牌登录→签名Cookie) ──► DSH Web(127.0.0.1:<webPort>)
                    · 非白名单请求 → 401/302 登录页
                    · Host/Origin 重写为 127.0.0.1:<webPort>，通过浏览器信任栅栏
                    · HTTP + WebSocket(事件 mux) 都转发
```

DSH 本体保持安全姿态不变：Web 服务器仍只绑定回环地址（`--host 0.0.0.0` 依旧被拒绝），只有**带鉴权**的网关监听网络。所有转发请求都携带重写后的 `Host`/`Origin` 头，[浏览器信任栅栏](../../client/connection/README.md)会把它当作本地请求一样放行。

## 安装到 web profile

插件在 `dsh web` 进程内挂载第二个监听端口。两种等价方式：

**A. 用户层行（本部署采用的方式）** —— 追加到 `$DSH_HOME/profiles/web/cordis.patch.yml`：

```yaml
- insert:
    - id: mobile-gateway
      name: '@deepseek-ai/dsh-mobile-gateway'
      inject: [webServer]
      config:
        bind: 0.0.0.0
        port: 4080
        targetHost: 127.0.0.1
        targetPort: !!js ctx.webServer.port   # real port incl. --port 0
        sessionTtlSeconds: 604800
        secret: ''                            # empty → per-process random secret
        tlsKeyPath: ''
        tlsCertPath: ''
        users:
          - name: alice-phone
            token: <openssl rand -hex 24>
```

profile 补丁支持配置热重载（config HMR）：保存文件即生效，无需重启 `dsh web`。

**B. Bundle 安装** —— 把本包作为 profile 层，执行 `dsh plugin --profile web add <路径或包名>`；随包携带的 `cordis.patch.yml` 会插入默认行，`users` 写在 profile 自己的 patch 层。

> 包必须能被运行中的 dsh 解析：本包是 workspace 成员（`@deepseek-ai/dsh-mobile-gateway`），下次启动时 `healProfilesModuleFallback` 会把它链接进 `$DSH_HOME/profiles/node_modules`。如果要在运行中的进程里热挂载，需要手动建 junction（见 `install.ps1`）。

## 配置

| 配置键 | 环境变量（插件内） | 默认值 | 含义 |
|---|---|---|---|
| `bind` | `DSH_MOBILE_GATEWAY_BIND` | `0.0.0.0` | 网关监听地址 |
| `port` | `DSH_MOBILE_GATEWAY_PORT` | `4080` | 网关监听端口 |
| `targetHost` | `DSH_MOBILE_GATEWAY_TARGET_HOST` | `127.0.0.1` | 上游主机（DSH web） |
| `targetPort` | `DSH_MOBILE_GATEWAY_TARGET_PORT` | `0` → `ctx.webServer.port` | 上游端口 |
| `users` | `DSH_MOBILE_GATEWAY_USERS`（`name:token,…`） | `[]` | 白名单；**为空 = 拒绝一切登录** |
| `sessionTtlSeconds` | `DSH_MOBILE_GATEWAY_TTL_SECONDS` | `604800` | 签名会话有效期（秒） |
| `secret` | `DSH_MOBILE_GATEWAY_SECRET` | 每进程随机 | 会话 cookie 的 HMAC 密钥 |
| `tlsKeyPath` / `tlsCertPath` | `DSH_MOBILE_GATEWAY_TLS_KEY` / `_CERT` | `''` | PEM 证书对 → https:// 监听 |

环境变量会覆盖同名配置项（轮换令牌不必改 patch 文件）。独立运行模式只读环境变量，还支持裸令牌列表 `DSH_MOBILE_GATEWAY_TOKENS`（自动命名 `user-1…`）。

## 手机端使用

1. 手机连同一局域网，打开 `http://<电脑IP>:4080`（`ipconfig` 查 IP；网关启动时会打印地址）。
2. 输入用户名 + 令牌 → 进入 DSH Web GUI（代理会给 UI 页面注入 PWA manifest）。
3. **安装为 App**：浏览器菜单 →「添加到主屏幕」。注意 PWA 安装需要 HTTPS 或 localhost；纯局域网 HTTP 下页面仍可完整使用，且下面的 Android App 不需要 HTTPS。
4. `android/` 目录是 Android WebView 工程（Kotlin，零第三方依赖），自动用保存的令牌登录；用 Android Studio（SDK 34，minSdk 24）构建 APK 装到手机 —— 见 `android/README.md`。

## 远程访问（不只是局域网）

网关不限于局域网：它监听在 `0.0.0.0` 上，凡是路由 + 防火墙能到达该端口的设备都能访问。按你的网络情况选一条路：

| 方案 | 需要公网IP/域名 | 手机体验 | 适用 |
|---|---|---|---|
| frp（本仓库一键脚本） | 是（自备服务器） | 固定地址；配合 Caddy 可自动 HTTPS | 有公网服务器（推荐） |
| Tailscale / ZeroTier | 否 | 手机装 App 加入同一虚拟网，访问 `http://<tailscale-ip>:4080`，全程 WireGuard 加密 | 想零暴露、免注册服务器 |
| Cloudflare Tunnel | 否 | 自动 HTTPS、浏览器零警告；可加 Cloudflare Access 限定设备 | 免证书、零暴露 |
| 公网直连 | 是（云服务器或端口转发） | 需要 TLS（自签名会警告；建议域名 + Let's Encrypt） | 已有公网服务器 |
| ngrok | 否（需注册账号） | 一条命令暴露；免费版 URL 随机 | 不想维护服务器 |

### frp（你自己的公网服务器）

完整手册见 [`frp/README.md`](frp/README.md) —— 简版如下：

```sh
# Server (Linux): one-shot setup with your strong token
sudo ./install-frps.sh <strong-token>
# This PC (Windows): connect to it, tunnel the gateway port
powershell -ExecutionPolicy Bypass -File packages/host/mobile-gateway/frp/setup-frpc.ps1 `
  -ServerIp <server-ip> -Token <strong-token> -RemotePort 4080
# Phones then use http://<server-ip>:4080  (add Caddy on the server for HTTPS)
```

### Tailscale（最简单也最安全）

```sh
# PC: install + log in; note your 100.x.y.z address
tailscale up
# Phone: install the Tailscale app, sign in to the SAME account,
# then open http://100.x.y.z:4080 — the gateway config stays untouched
# (bind 0.0.0.0, port 4080). Tailscale ACLs restrict which devices may connect.
```

### Cloudflare Tunnel（自动 HTTPS，无需公网 IP）

```sh
# Quick tunnel (no account, random URL — good for a demo):
cloudflared tunnel --url http://127.0.0.1:4080
# Named tunnel (fixed hostname): cloudflared tunnel login -> create ->
# route dns <name> <hostname>, then add a Cloudflare Access policy that
# only lets your phones through.
```

### 公网直连（云服务器或端口转发）

```sh
# 1. Generate a self-signed certificate (zero-dependency script):
powershell -ExecutionPolicy Bypass -File scripts/gen-tls.ps1
# 2. Point tlsKeyPath / tlsCertPath at the two files in the mobile-gateway
#    row of the profile patch (saving hot-applies it).
# 3. Open only that port in the firewall. For production prefer a real
#    domain + Let's Encrypt (certbot) over a self-signed cert.
```

> 安全提醒：网关是访问控制层，不是 WAF。公网直连务必启用 TLS，令牌保持强随机：`node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`。固定域名的隧道建议用 Cloudflare Access 或 Tailscale ACL 限定设备；临时隧道 URL 会变化，只适合演示。

## 安全模型

- **默认拒绝一切**：没有配置 `users` 时，所有登录都会失败、所有请求都会被拒 —— 网关绝不会意外暴露 DSH。
- 令牌用恒定时间比较；会话 cookie 带 `HttpOnly`、`SameSite=Lax`、HMAC-SHA256 签名，并且**每次请求**都重新核对白名单 —— 从名单移除用户即可立即让其现有会话失效。
- 会话是无状态的：退出登录只是浏览器侧丢弃 cookie；被复制的 cookie 值在过期（TTL）前仍有效。想立刻让所有人下线：更换 `secret`（改 patch 即热生效）。
- 网关默认是明文 HTTP —— 请在可信局域网 / SSH 隧道 / Tailscale 下使用；跨公网必须配置 `tlsKeyPath`/`tlsCertPath`。它是访问控制，不是完整 WAF：暂无速率限制。
- DSH 本体从不绑定网络接口，只有带鉴权的网关监听网络。

## 验证

```sh
curl http://127.0.0.1:4080/__mobile/health        # {ok:true, target:"http://127.0.0.1:3080", users:N}
curl -i -X POST -d 'user=alice&token=…' http://127.0.0.1:4080/__mobile/login   # 302 + set-cookie
curl -b 'dsh_mgw_session=…' http://127.0.0.1:4080/   # DSH UI html with injected PWA meta
```

## 开发

```sh
pnpm --filter @deepseek-ai/dsh-mobile-gateway build   # tsc -b + copy JS to lib/
pnpm --filter @deepseek-ai/dsh-mobile-gateway test    # vitest: auth, proxy, WS, meta injection
node lib/standalone.js                                 # standalone mode (env-configured)
```

本包取代了手写的 `data/plugins/dsh-web-gateway/gateway.mjs` 独立脚本：行为相同，另加签名会话登录、PWA 壳与进程内集成。

## Model Experience

### Gateway access control

#### What the model sees

The gateway itself contributes no prompt, tool, or context to any model request; the pages and `/api` traffic it forwards are produced entirely by the DSH packages behind it (`dsh-host-webserver`, `dsh-client-connection`, the frontend), and the `Host`/`Origin` rewrite it applies never touches request bodies.

#### Token effect

None beyond the bytes it forwards verbatim — the gateway never assembles, expands, or rewrites model prompts, and it strips only hop-by-hop and `Host`/`Origin` headers.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Stateless sessions** — logout is a client-side cookie discard; a stolen cookie value remains valid until TTL (documented revocation path: remove the user or rotate `secret`). A server-side session store is deferred.
- **No rate limiting or brute-force backoff** — repeated failed logins are logged but not throttled; add a reverse proxy with rate limiting (or the deferred in-gateway limiter) before exposing to the internet.
- **Plain HTTP by default** — tokens and traffic are unencrypted on the LAN; TLS termination is supported via `tlsKeyPath`/`tlsCertPath` but not automatic (no ACME/Let's Encrypt yet).
- **Login-page flow is the only UI** — the gateway serves one token form; multi-factor or per-user passwords are deferred.
- **PWA install requires a secure context** — over plain HTTP, phones can still use the page and the Android app; the "Add to Home screen" install prompt needs HTTPS.
- **No multi-tenant isolation** — all authenticated users share the same DSH host instance and session list; the gateway restricts WHO reaches it, not what each user can do inside DSH.
