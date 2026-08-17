# @deepseek-ai/dsh-mobile-gateway

English | [中文](README.zh.md)

An authenticated reverse proxy that lets **named phone users** open the DSH Web GUI from their phones, plus the mobile app shell around it: a signed-session login page, a PWA (installable app), and an Android WebView project. The proxy runs **inside** the `dsh --profile web` process as a Cordis plugin (or standalone via `node lib/standalone.js`).

```
手机浏览器/App ──► 网关(0.0.0.0:4080, 令牌登录→签名Cookie) ──► DSH Web(127.0.0.1:<webPort>)
                    · 非白名单请求 → 401/302 登录页
                    · Host/Origin 重写为 127.0.0.1:<webPort>，通过浏览器信任栅栏
                    · HTTP + WebSocket(事件 mux) 都转发
```

DSH keeps its safety posture: the web server stays bound to loopback (`--host 0.0.0.0` remains refused), and only the **authenticated** gateway listens on the network. Every forwarded request carries rewritten `Host`/`Origin` headers, so the [browser-trust fence](../../client/connection/README.md) accepts it exactly like a local request.

## Install into the web profile

The plugin mounts a second listener inside the `dsh web` process. Two equivalent ways:

**A. User-layer row (what this deployment uses)** — append to `$DSH_HOME/profiles/web/cordis.patch.yml`:

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

The profile patch is hot-reloaded (config HMR): save the file and the gateway starts without restarting `dsh web`.

**B. Bundle install** — package this as a profile layer and run `dsh plugin --profile web add <path-or-package>`; the shipped `cordis.patch.yml` inserts the row with defaults, and your `users` go in the profile's own patch layer.

> The package must be resolvable from the running app: it ships as a workspace member (`@deepseek-ai/dsh-mobile-gateway`), and `healProfilesModuleFallback` links it into `$DSH_HOME/profiles/node_modules` on the next boot. If you add it to a running process, create the junction manually (see `install.ps1`).

## Configuration

| Config key | Env var (plugin) | Default | Meaning |
|---|---|---|---|
| `bind` | `DSH_MOBILE_GATEWAY_BIND` | `0.0.0.0` | gateway listen address |
| `port` | `DSH_MOBILE_GATEWAY_PORT` | `4080` | gateway listen port |
| `targetHost` | `DSH_MOBILE_GATEWAY_TARGET_HOST` | `127.0.0.1` | upstream host (the DSH web server) |
| `targetPort` | `DSH_MOBILE_GATEWAY_TARGET_PORT` | `0` → `ctx.webServer.port` | upstream port |
| `users` | `DSH_MOBILE_GATEWAY_USERS` (`name:token,…`) | `[]` | the whitelist; **empty = every login denied** |
| `sessionTtlSeconds` | `DSH_MOBILE_GATEWAY_TTL_SECONDS` | `604800` | signed-session lifetime |
| `secret` | `DSH_MOBILE_GATEWAY_SECRET` | random per process | HMAC secret for session cookies |
| `tlsKeyPath` / `tlsCertPath` | `DSH_MOBILE_GATEWAY_TLS_KEY` / `_CERT` | `''` | PEM pair → https:// listener |

Env entries override same-named config entries (rotate a token without touching the patch file). The standalone runner reads env only and also accepts bare `DSH_MOBILE_GATEWAY_TOKENS` (auto-named `user-1…`).

## Phone usage

1. Phone on the same LAN opens `http://<电脑IP>:4080` (find the IP with `ipconfig`; the gateway prints the URL at startup).
2. Enter user + token → the DSH Web GUI loads (the proxy injects a PWA manifest into the UI page).
3. **Install as an app**: browser menu → "Add to Home screen" (PWA install needs HTTPS or `localhost`; over plain LAN HTTP the page still fully works as a web app, and the Android app below needs no HTTPS).
4. The Android app project in `android/` (Kotlin + WebView, zero third-party deps) logs in with the saved token automatically; build it in Android Studio (SDK 34, minSdk 24) and install the APK on the phone — see `android/README.md`.

## Remote access (beyond the LAN)

The gateway is not LAN-only: it listens on `0.0.0.0`, so anything with route + firewall access to that port can reach it. Pick the path that fits your network:

| 方案 | 需要公网IP/域名 | 手机体验 | 适用 |
|---|---|---|---|
| frp（本仓库一键脚本） | 是（自备服务器） | 固定地址；配合 Caddy 可自动 HTTPS | 有公网服务器（推荐） |
| Tailscale / ZeroTier | 否 | 手机装 App 加入同一虚拟网，访问 `http://<tailscale-ip>:4080`，全程 WireGuard 加密 | 想零暴露、免注册服务器 |
| Cloudflare Tunnel | 否 | 自动 HTTPS、浏览器零警告；可加 Cloudflare Access 限定设备 | 免证书、零暴露 |
| 公网直连 | 是（云服务器或端口转发） | 需要 TLS（自签名会警告；建议域名 + Let's Encrypt） | 已有公网服务器 |
| ngrok | 否（需注册账号） | 一条命令暴露；免费版 URL 随机 | 不想维护服务器 |

### frp（你自己的公网服务器）

Full walkthrough in [`frp/README.md`](frp/README.md) — here is the short version:

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

### Direct public access（云服务器或端口转发）

```sh
# 1. Generate a self-signed certificate (zero-dependency script):
powershell -ExecutionPolicy Bypass -File scripts/gen-tls.ps1
# 2. Point tlsKeyPath / tlsCertPath at the two files in the mobile-gateway
#    row of the profile patch (saving hot-applies it).
# 3. Open only that port in the firewall. For production prefer a real
#    domain + Let's Encrypt (certbot) over a self-signed cert.
```

> Security: the gateway is an access-control layer, not a WAF. For direct public exposure always enable TLS and keep tokens strongly random: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`. Fixed-hostname tunnels should be locked down with Cloudflare Access or Tailscale ACLs; quick-tunnel URLs rotate and are demo-grade only.

## Security model

- **Deny-all default**: with no `users`, every login fails and every request is refused — the gateway never exposes DSH by accident.
- Tokens are compared in constant time; the session cookie is `HttpOnly`, `SameSite=Lax`, HMAC-SHA256 signed, and re-checks the whitelist on **every** request, so removing a user also denies their existing session immediately.
- Sessions are stateless: logout discards the cookie client-side; a copied cookie value stays valid until its expiry (TTL). To force-logout everyone instantly, change `secret` (rotate it with the patch HMR).
- The gateway itself is plain HTTP by default — use it on a trusted LAN, over SSH/Tailscale, or set `tlsKeyPath`/`tlsCertPath` when crossing the internet. It is access control, not a full WAF: no rate limiting yet.
- DSH itself never binds a network interface; only the authenticated gateway does.

## Verification

```sh
curl http://127.0.0.1:4080/__mobile/health        # {ok:true, target:"http://127.0.0.1:3080", users:N}
curl -i -X POST -d 'user=alice&token=…' http://127.0.0.1:4080/__mobile/login   # 302 + set-cookie
curl -b 'dsh_mgw_session=…' http://127.0.0.1:4080/   # DSH UI html with injected PWA meta
```

## Development

```sh
pnpm --filter @deepseek-ai/dsh-mobile-gateway build   # tsc -b + copy JS to lib/
pnpm --filter @deepseek-ai/dsh-mobile-gateway test    # vitest: auth, proxy, WS, meta injection
node lib/standalone.js                                 # standalone mode (env-configured)
```

This package supersedes the hand-rolled `data/plugins/dsh-web-gateway/gateway.mjs` standalone script with the same behavior plus signed-session login, the PWA shell, and in-process integration.

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
