# frp — expose the DSH Mobile gateway over the internet through your own public server

English | [中文](README.zh.md)

frp has two parts: **`frps`** (the server daemon) runs on your public server,
**`frpc`** (the client) runs on this machine. Once frpc connects to frps over
an encrypted tunnel, phones reach the local gateway `127.0.0.1:4080` at
`http(s)://server-ip:remote-port`. No third-party account, fixed address,
your traffic end to end.

```
Phone ──► https://server-ip:4080 ──► frps(server:7000) ──encrypted──► frpc(this PC) ──► gateway 127.0.0.1:4080 ──► DSH Web
```

## Deploy in three steps

### 1. Server side (Linux, once)

Copy `install-frps.sh` to the server and run it, or do it by hand:

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

`install-frps.sh` downloads frp, writes `/etc/frp/frps.toml` (with the token
you pass), registers a systemd service and starts it. Usage:

```sh
chmod +x install-frps.sh
./install-frps.sh your-strong-token
```

### 2. Client side (Windows, from this repo)

```powershell
powershell -ExecutionPolicy Bypass -File packages/host/mobile-gateway/frp/setup-frpc.ps1 `
  -ServerIp 1.2.3.4 -Token your-strong-token -RemotePort 4080
```

The script downloads the Windows frp build, writes `frpc.toml`, starts frpc
(optionally as a scheduled task for auto-start) and verifies the tunnel with a
local probe round-trip.

Equivalent manual `frpc.toml`:

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

### 3. Phones

- **Recommended (you own a domain)**: add Caddy on the server and phones use
  `https://dsh.example.com` with zero warnings. Keep frps's 4080 off the public
  firewall (only 443 open); Caddy issues the Let's Encrypt cert automatically:
  ```caddyfile
  dsh.example.com {
      reverse_proxy 127.0.0.1:4080
  }
  ```
- **No domain**: phones use `https://server-ip:4080`. If the gateway has no
  TLS this is plain HTTP — **enable TLS on the gateway when crossing the
  internet** (`scripts/gen-tls.ps1` for a self-signed cert; tick "trust
  self-signed" in the Android app; browsers will warn but work).
- Phone login is identical to the LAN flow: user + token → DSH Web.

## Security checklist

- `auth.token` must be strongly random and identical on frps and frpc.
- Without a domain, TLS is mandatory for public exposure; otherwise tokens and
  traffic cross the internet in plaintext.
- Open only the needed ports in the server firewall: `7000` (frp control) and
  `4080` (the tunnel — or only `443` when going through Caddy).
- Token leaked? Rotate the `users` token in the gateway config — old sessions
  die immediately.
