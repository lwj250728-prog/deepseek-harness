# frp — 通过你自己的公网服务器把 DSH Mobile 网关暴露到互联网

[English](README.md) | 中文

frp 由两部分组成：**公网服务器**上跑 `frps`（服务端），**本机**跑 `frpc`（客户端）。
frpc 与 frps 建立加密隧道后，手机访问 `http(s)://服务器IP:远程端口` 就能到达本机网关
`127.0.0.1:4080`。不需要注册任何第三方账号，地址固定、流量自控。

```
Phone ──► https://server-ip:4080 ──► frps(server:7000) ──encrypted──► frpc(this PC) ──► gateway 127.0.0.1:4080 ──► DSH Web
```

## 部署三步

### 1. 服务器端（Linux，一次性）

把 `install-frps.sh` 传到服务器执行，或手动按下面来：

```sh
# Download frp (v0.61.1 in the example; change the URL for other versions)
wget https://github.com/fatedier/frp/releases/download/v0.61.1/frp_0.61.1_linux_amd64.tar.gz
tar xzf frp_0.61.1_linux_amd64.tar.gz && cd frp_0.61.1_linux_amd64
# Write the config (change the token!)
cat > frps.toml <<'EOF'
bindPort = 7000
auth.token = "<strong-random-token>"
EOF
# Test in the foreground
./frps -c frps.toml
# Once it works, register it with systemd as in install-frps.sh
```

`install-frps.sh` 会：下载 frp → 写 `/etc/frp/frps.toml`（用你给的 token）→
注册 systemd 服务并启动。用法：

```sh
chmod +x install-frps.sh
./install-frps.sh your-strong-token
```

### 2. 本机客户端（Windows，本仓库脚本）

```powershell
powershell -ExecutionPolicy Bypass -File packages/host/mobile-gateway/frp/setup-frpc.ps1 `
  -ServerIp 1.2.3.4 -Token your-strong-token -RemotePort 4080
```

脚本会：下载 frp Windows 版 → 生成 `frpc.toml` → 启动 frpc（并可选注册计划任务开机自启）→
验证隧道连通（本地起一个探针端口往返检查）。

手动等价配置 `frpc.toml`：

```toml
serverAddr = "1.2.3.4"
serverPort = 7000
auth.token = "your-strong-token"

[[proxies]]
name = "dsh-mobile"
type = "tcp"
localIP = "127.0.0.1"
localPort = 4080
remotePort = 4080
```

### 3. 手机

- **推荐（有域名）**：服务器上再加 Caddy 反代，手机访问 `https://dsh.example.com`，零警告。
  frps 的 4080 不必暴露公网（防火墙只开 443），Caddy 自动签 Let's Encrypt 证书：
  ```caddyfile
  dsh.example.com {
      reverse_proxy 127.0.0.1:4080
  }
  ```
- **无域名**：手机访问 `https://服务器IP:4080`。若网关未配 TLS 则是明文 HTTP——
  **跨公网请务必给网关启用 TLS**（`scripts/gen-tls.ps1` 自签名；Android App 勾"信任自签名"，
  浏览器会有警告但可用）。
- 手机登录流程与局域网一致：用户 + 令牌 → DSH Web。

## 安全清单

- `auth.token` 用强随机值，frps 与 frpc 必须一致。
- 公网无域名时必须 TLS（自签名或域名证书）；否则令牌与流量在互联网明文传输。
- 服务器防火墙只放行需要的端口：`7000`（frp 控制）、`4080`（隧道，若走 Caddy 则改只开 `443`）。
- 令牌泄漏即改：换 `users` 里的 token 立即失效旧会话。
