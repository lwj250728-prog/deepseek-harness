#!/usr/bin/env bash
#
# start-dsh.sh — boot DeepSeek Harness on Linux (Web UI by default).
#
# 用法 / Usage:
#   ./start-dsh.sh                        从本仓库启动 Web UI（默认 http://127.0.0.1:3080）
#   ./start-dsh.sh --port 8080            指定端口
#   ./start-dsh.sh --skip-build           跳过构建（已构建过时更快启动）
#   ./start-dsh.sh --profile headless "列出本仓库的顶层目录"   一次性 headless 任务
#   ./start-dsh.sh --help                 显示帮助
#
# 依赖 / Requirements:
#   - Node.js ^22.19 || >=24（推荐用 nvm: https://github.com/nvm-sh/nvm）
#   - pnpm（脚本会自动通过 corepack 或 npm 安装，无需手动准备）
#   - 网络（首次 pnpm install / npx 需要）
#
# 模型密钥 / API key:
#   方式一：启动后在 Web UI 的 Settings -> Models 填写；
#   方式二：export DEEPSEEK_API_KEY=sk-... 后再启动；
#   方式三：在本仓库根目录创建 .env，内容为 DEEPSEEK_API_KEY=sk-...。
#
# 两种运行模式（自动检测）:
#   源码模式：把本脚本放在 deepseek-harness 仓库根目录运行，
#            依次执行 pnpm install -> pnpm run build -> pnpm dsh web。
#   npm 模式：把脚本单独复制到任意目录运行，等价于 npx @deepseek-ai/dsh web。
#
# 注意: 首次运行前执行 chmod +x start-dsh.sh。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="${DSH_PROFILE:-web}"
SKIP_INSTALL=0
SKIP_BUILD=0
DSH_ARGS=()

# ── helpers ──────────────────────────────────────────────────────────────────

info()  { printf '\033[1;36m[dsh]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[dsh-warn]\033[0m %s\n' "$*" >&2; }
die()   { printf '\033[1;31m[dsh-error]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: ./start-dsh.sh [options] [dsh-args...]

Boot DeepSeek Harness on Linux. Default profile: web (Web UI at
http://127.0.0.1:3080). Run inside a deepseek-harness checkout for source mode
(pnpm install + build + dsh); anywhere else boots the published npm package.

Options:
  -h, --help             show this help and exit
  --profile <name>       boot another profile (default: $DSH_PROFILE or "web";
                         e.g. --profile headless "task text")
  --skip-install         skip pnpm install (dependencies already present)
  --skip-build           skip pnpm run build (frontend dist already built)
  --                     end of start-dsh options; everything after passes to dsh

Anything else is forwarded to `dsh` verbatim, e.g. --port 8080,
--host 127.0.0.1, --trusted-host app.internal:3080.

Environment:
  DSH_PROFILE             default profile to boot (default: web)
  DSH_HOME                harness home directory (default: ~/.dsh)
  DEEPSEEK_API_KEY        model API key; also settable in Web UI Settings -> Models
  DSH_TELEMETRY_DISABLED  any non-empty value disables telemetry
EOF
}

# ── argument parsing ─────────────────────────────────────────────────────────

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --profile)
      [ $# -ge 2 ] || die "--profile needs a name"
      PROFILE="$2"; shift 2 ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    --skip-build)   SKIP_BUILD=1;   shift ;;
    --) shift; DSH_ARGS+=("$@"); break ;;
    -*) DSH_ARGS+=("$1"); shift ;;
    *)  DSH_ARGS+=("$1"); shift ;;
  esac
done

# ── prerequisites ────────────────────────────────────────────────────────────

command -v node >/dev/null 2>&1 || die "Node.js not found. Install ^22.19 or >=24 (e.g. via nvm: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash), then re-run."

if ! node -e '
  const [maj, min] = process.versions.node.split(".").map(Number)
  process.exit(maj === 22 ? (min >= 19 ? 0 : 1) : maj >= 24 ? 0 : 1)
' 2>/dev/null; then
  die "Node.js $(node --version) is not supported; DeepSeek Harness needs ^22.19 || >=24."
fi
NODE_VERSION="$(node --version)"
info "Node.js ${NODE_VERSION}"

ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    return
  fi
  # 1) corepack shims. On distro-packaged Node the shim dir (/usr/bin) is
  # root-owned, so `corepack enable` fails without sudo; that is fine — the
  # prepare step still caches pnpm, and `corepack pnpm` runs it directly.
  if command -v corepack >/dev/null 2>&1; then
    info "Installing pnpm 11.7.0 via corepack ..."
    corepack enable >/dev/null 2>&1 || true
    corepack prepare pnpm@11.7.0 --activate >/dev/null 2>&1 || true
    if command -v pnpm >/dev/null 2>&1; then return; fi
    if corepack pnpm --version >/dev/null 2>&1; then
      info "Using a session shim that runs pnpm through corepack ..."
      mkdir -p "$HOME/.local/bin"
      cat > "$HOME/.local/bin/pnpm" <<'EOF'
#!/usr/bin/env sh
exec corepack pnpm "$@"
EOF
      chmod +x "$HOME/.local/bin/pnpm"
      export PATH="$HOME/.local/bin:$PATH"
      return
    fi
  fi
  # 2) user-level npm global install. The global bin directory is often NOT
  # on PATH (npm prefix like ~/.npm-global), so resolve it and prepend it.
  command -v npm >/dev/null 2>&1 || die "Neither pnpm nor npm is available. Install Node.js first."
  info "Installing pnpm via npm ..."
  npm install -g pnpm@11.7.0 --no-fund --no-audit
  NPM_GLOBAL_BIN="$(npm prefix -g 2>/dev/null)/bin"
  if [ -n "$NPM_GLOBAL_BIN" ] && [ -x "$NPM_GLOBAL_BIN/pnpm" ]; then
    export PATH="$NPM_GLOBAL_BIN:$PATH"
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    die "pnpm is installed but its global bin directory is not on PATH. Add '$(npm prefix -g)/bin' to your PATH (e.g. in ~/.bashrc), or run 'sudo corepack enable' once, then re-run this script."
  fi
  pnpm --version >/dev/null 2>&1 || die "pnpm is on PATH but not runnable; check the node it resolves to."
}

is_repo_checkout() {
  [ -f "$SCRIPT_DIR/package.json" ] \
    && grep -q '"@deepseek-ai/dsh-root"' "$SCRIPT_DIR/package.json" \
    && [ -d "$SCRIPT_DIR/apps/cli" ]
}

# ── API key hint (non-fatal; the Web UI accepts a key at runtime) ────────────

if [ -z "${DEEPSEEK_API_KEY:-}" ] \
  && ! { [ -f "$SCRIPT_DIR/.env" ] && grep -q '^DEEPSEEK_API_KEY=' "$SCRIPT_DIR/.env"; }; then
  warn "DEEPSEEK_API_KEY is not set and no .env carries one."
  warn "You can still start; enter the key later in Web UI Settings -> Models,"
  warn "or restart with: export DEEPSEEK_API_KEY=sk-..."
fi

# ── boot ─────────────────────────────────────────────────────────────────────

if is_repo_checkout; then
  info "Source mode: using the deepseek-harness checkout at $SCRIPT_DIR"
  ensure_pnpm

  # node_modules may exist from a plain `npm install` (no pnpm .pnpm layout);
  # pnpm install then repairs it, so require the pnpm store marker.
  if [ "$SKIP_INSTALL" -eq 0 ] \
    && { [ ! -d "$SCRIPT_DIR/node_modules" ] || [ ! -d "$SCRIPT_DIR/node_modules/.pnpm" ]; }; then
    info "Running pnpm install (first run) ..."
    (cd "$SCRIPT_DIR" && pnpm install)
  fi

  # The Web UI serves the built frontend from apps/web/dist; without it the
  # boot fails loud. The full build also emits the host/client lib artifacts.
  if [ "$SKIP_BUILD" -eq 0 ] && [ ! -f "$SCRIPT_DIR/apps/web/dist/index.html" ]; then
    info "Running pnpm run build (first run) ..."
    (cd "$SCRIPT_DIR" && pnpm run build)
  fi

  info "Booting profile '$PROFILE' with: pnpm dsh --profile $PROFILE ${DSH_ARGS[*]}"
  exec pnpm dsh --profile "$PROFILE" "${DSH_ARGS[@]}"
else
  info "npm mode: not inside a checkout; using npx @deepseek-ai/dsh"
  exec npx --yes @deepseek-ai/dsh --profile "$PROFILE" "${DSH_ARGS[@]}"
fi
