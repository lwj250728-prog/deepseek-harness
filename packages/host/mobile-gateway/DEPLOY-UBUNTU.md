# DSH Mobile Gateway — Ubuntu 服务器部署手册

> 适用场景：**DSH 本体部署在 Ubuntu 服务器上**，手机通过公网直接访问服务器上的 DSH Web。本手册把鉴权网关插件（`mobile-gateway`）装进服务器的 DSH，手机经 `https://服务器IP:4080` 安全访问。**不需要 frp 中转**——frp 只在 DSH 与公网服务器不在同一台机器时才需要（见 `frp/README.md`）。

## 目标架构

```
手机浏览器/App ──► https://服务器IP:4080 ──► mobile-gateway(鉴权) ──► DSH Web(127.0.0.1:3080)
                    · 令牌登录 → 签名 Cookie
                    · Host/Origin 重写，通过浏览器信任栅栏
                    · HTTP + WebSocket 全转发
```

## 前置条件

- Ubuntu 服务器（有公网 IP），DSH 已**源码部署**并运行（`dsh --profile web` 监听 `127.0.0.1:3080`）
- 服务器可 `sudo`
- 你的电脑上有本仓库源码（含 `packages/host/mobile-gateway`），能 `scp` 到服务器

## 第 1 步：定位源码与配置目录

```bash
echo $DSH_HOME                     # 若为空，默认配置根是 ~/.dsh
ls ~/deepseek-harness              # 你的 DSH 源码目录（按实际替换）
ls ~/.dsh/profiles/web/cordis.patch.yml    # profile 补丁文件（默认位置）
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3080/   # 确认 DSH web 在跑（应 200）
```

> `DSH_HOME` 优先级：显式配置 > `$DSH_HOME` > `~/.dsh`。后面的 `$DSH_HOME` 都按你实际解析到的目录替换。

## 第 2 步：把插件包复制到服务器

在**你自己的电脑**上：

```bash
scp -r D:/DeepSeek-Harness/packages/host/mobile-gateway \
      ubuntu@<服务器IP>:~/deepseek-harness/packages/host/
```

## 第 3 步：注册依赖并构建（服务器上）

```bash
cd ~/deepseek-harness

# 3a. apps/cli 依赖该包（闭包链接需要）
node -e "
const fs = require('fs');
const p = 'apps/cli/package.json';
const j = JSON.parse(fs.readFileSync(p));
j.dependencies['@deepseek-ai/dsh-mobile-gateway'] = 'workspace:^';
fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
"

# 3b.（可选，仓库全量 typecheck 用）tsconfig.host.json 加一条 reference：
#     在 "packages/host/plugin-inventory" 之后加:
#     { "path": "./packages/host/mobile-gateway" },

# 3c. 链接 + 构建
pnpm install --prefer-offline
pnpm --filter @deepseek-ai/dsh-mobile-gateway build
```

## 第 4 步：生成 TLS 证书（公网必须加密）

```bash
sudo mkdir -p /etc/dsh-mobile/tls
sudo openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout /etc/dsh-mobile/tls/key.pem -out /etc/dsh-mobile/tls/cert.pem \
  -days 825 -subj "/CN=DSH Mobile Gateway" \
  -addext "subjectAltName=IP:$(curl -s ifconfig.me),IP:127.0.0.1"
sudo chmod 600 /etc/dsh-mobile/tls/key.pem
```

> 自签名证书：手机浏览器会提示"不安全/继续访问"（点继续即可）；**Android App 在设置页勾选"信任自签名证书"后零警告**；iOS 首次需安装描述文件。有域名时建议改用 Caddy + Let's Encrypt（自动证书，零警告）。

## 第 5 步：配置网关（用户白名单 + TLS）

编辑 `$DSH_HOME/profiles/web/cordis.patch.yml`（默认 `~/.dsh/profiles/web/cordis.patch.yml`），追加：

```yaml
- insert:
    - id: mobile-gateway
      name: '@deepseek-ai/dsh-mobile-gateway'
      inject: [webServer]
      config:
        bind: 0.0.0.0
        port: 4080
        targetHost: 127.0.0.1
        targetPort: !!js ctx.webServer.port
        sessionTtlSeconds: 604800
        secret: ''
        tlsKeyPath: '/etc/dsh-mobile/tls/key.pem'
        tlsCertPath: '/etc/dsh-mobile/tls/cert.pem'
        users:
          - name: alice            # 每个手机用户一条；令牌用强随机
            token: <openssl rand -hex 24>
```

> `users` 为空 = 拒绝一切登录（fail-closed）。改 `users` 或 `secret` 保存即热生效（配置 HMR，无需重启）。

## 第 6 步：重启 DSH web 并验证

```bash
# 按你平时的启动方式重启（systemd / screen / nohup），例如 systemd:
#   sudo systemctl restart dsh-web
# 或 screen:
#   screen -S dsh && cd ~/deepseek-harness && node apps/cli/lib/bin.js web

# 本机验证
curl -k https://127.0.0.1:4080/__mobile/health
# → {"ok":true,"gateway":"dsh-mobile-gateway",...,"users":1}

# 公网自测
curl -k -I https://<服务器IP>:4080/__mobile/health
```

## 第 7 步：防火墙

```bash
sudo ufw allow 4080/tcp
sudo ufw status
```

**同时**在云控制台安全组放行 `4080/tcp` 入方向（阿里云/腾讯云/AWS 安全组与 ufw 是两层，都要开）。

## 第 8 步：手机访问

```
https://<服务器IP>:4080
```

输入第 5 步配置的用户名 + 令牌 → 进入 DSH Web。浏览器菜单"添加到主屏幕"可装为 PWA；Android 也可构建 `android/` 工程装 APK（自动登录、信任自签名）。

## （可选）systemd 托管 DSH web

```ini
# /etc/systemd/system/dsh-web.service
[Unit]
Description=DeepSeek Harness Web
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/deepseek-harness
ExecStart=/usr/bin/node apps/cli/lib/bin.js web
Restart=on-failure
RestartSec=3
Environment=DSH_HOME=/home/ubuntu/.dsh

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now dsh-web
```

## 清理错误的 frp 中转架构（如之前误配过）

```bash
sudo systemctl disable --now frps      # 停 frp 服务端
# 服务器上删配置: sudo rm -rf /etc/frp /opt/frp /etc/systemd/system/frps.service
# Windows 上: 停掉 frpc 进程/计划任务（setup-frpc.ps1 -AutoStart 注册过的任务名 "DSH Mobile frpc"）
```

## 常见问题

| 现象 | 原因/处理 |
|---|---|
| `curl -k https://127.0.0.1:4080/__mobile/health` 连不上 | 插件没挂载：检查 patch 语法、`name` 包名、包是否构建；`dsh --profile web --dump-config` 看行是否在 |
| 手机提示"用户名或令牌不对" | 用户名全小写（登录页已禁用自动大写）；令牌复制粘贴勿手输；登录页可只填令牌（用户名留空） |
| 浏览器证书警告 | 自签名正常现象；Android App 勾"信任自签名证书"；有域名换 Caddy |
| 局域网能访问、公网不行 | 云安全组没放行 4080（最常见） |
| 改了 patch 不生效 | 确认改的是 `$DSH_HOME/profiles/web/cordis.patch.yml`（不是源码里的）；保存即热生效，无需重启 |
