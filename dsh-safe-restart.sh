#!/usr/bin/env bash
# dsh-safe-restart.sh — 安全重启 dsh web（user 级服务；防插件错误崩溃循环 + 自我感知）
#
# 背景教训（exp_98）：
#   1. 当前 web 由 **user 级** systemd 服务承载（Hermes 托管, lib/bin.js）。
#      system 级 dsh-web.service 已禁用——不要再操作它。
#   2. agent 运行在被重启的服务里——重启 = 中断当前会话。本脚本在重启前
#      打印"自我感知"警告，提示该操作会重启承载当前对话的进程。
#   3. quiet-driver 曾因语法错误导致崩溃循环（NRestarts=793）。重启前先预检
#      最近改动的插件（tsx 冒烟加载），把错误挡在重启之前。
#
# 用法:
#   ./dsh-safe-restart.sh              # 预检 → 重启 user 级服务 → 健康确认
#   ./dsh-safe-restart.sh --force      # 跳过预检直接重启
#   ./dsh-safe-restart.sh --verify-only  # 只预检不重启
#   ./dsh-safe-restart.sh --status     # 只看状态（含自我感知信息）
#
set -euo pipefail

DSH_ROOT="${DSH_ROOT:-/home/ubuntu/dsh-fork}"
CHECK_WINDOW_MIN="${CHECK_WINDOW_MIN:-120}"
CHECK_TIMEOUT_S="${CHECK_TIMEOUT_S:-30}"
SERVICE="dsh-web.service"
CTL="systemctl --user"   # user 级（当前正统；system 级已禁用）

log() { echo "[safe-restart] $*"; }
die() { log "✗ $*" >&2; exit 1; }

# ---------- 0. 自我感知（exp_98：我是被重启的进程内的实体） ----------
self_awareness() {
  log "⚠ 自我感知：当前 web 由 ${CTL} 承载。重启/停服会中断运行中的对话会话。"
  log "  运行中的实例: PID $(systemctl --user show "$SERVICE" -p MainPID --value 2>/dev/null || echo none)"
  log "  若要保留对话连续性，确认会话已落盘（session.jsonl 自动写入）后再重启。"
}

# ---------- 1. 找出最近修改的插件源码 ----------
find_changed_plugins() {
  find "$DSH_ROOT/packages" -path '*/src/*.ts' -newermt "-${CHECK_WINDOW_MIN} minutes" \
    -not -path '*/node_modules/*' 2>/dev/null \
    | sed -E 's|.*/packages/([^/]+/[^/]+)/src/.*|\1|' \
    | sort -u
}

# ---------- 2. 对每个改动插件做 tsx 冒烟加载 ----------
verify_plugin() {
  local pkg_dir="$1"
  local entry="$pkg_dir/src/index.ts"
  [ -f "$entry" ] || { log "  跳过 $pkg_dir（无 src/index.ts）"; return 0; }
  log "  预检 $pkg_dir ..."
  if ! (cd "$DSH_ROOT" && timeout "$CHECK_TIMEOUT_S" npx tsx --eval \
      "import('file://$entry').then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})" \
      >/tmp/dsh-safe-restart-check.log 2>&1); then
    log "  ✗ $pkg_dir 加载失败：" >&2
    tail -n 8 /tmp/dsh-safe-restart-check.log >&2 || true
    return 1
  fi
  log "  ✓ $pkg_dir OK"
  return 0
}

verify_patch() {
  # 2026-09-08 07:2x 崩溃教训固化: patch entry 格式错(id用包名/无insert包裹)曾致88次崩溃循环。
  # 轻量预检: 每个顶层 insert entry 须有 id+name 完整结构(loader 定位靠 name)。
  # 注: dsh patch 允许 `!!js` 表达式(loader 运行时求值)——校验只关心结构, 给 !!js 注册占位构造器即可。
  local patch="${PATCH_FILE:-/home/ubuntu/.dsh/profiles/web/cordis.patch.yml}"
  [ -f "$patch" ] || { log "无 patch 文件, 跳过"; return 0; }
  # 用 python 校验 YAML 顶层结构（注册 !!js 占位构造器，避免未知标签误报）
  python3 - "$patch" << 'PYEOF2'
import sys, yaml
class Loader(yaml.SafeLoader):
    pass
def js_placeholder(loader, node):
    # dsh loader 运行时表达式, 结构校验无需展开——占位返回即可
    if isinstance(node, yaml.ScalarNode):
        return loader.construct_scalar(node)
    if isinstance(node, yaml.SequenceNode):
        return loader.construct_sequence(node, deep=True)
    if isinstance(node, yaml.MappingNode):
        return loader.construct_mapping(node, deep=True)
    return None
Loader.add_constructor('tag:yaml.org,2002:js', js_placeholder)
try:
    with open(sys.argv[1]) as f:
        docs = list(yaml.load_all(f, Loader=Loader))
    for doc in docs:
        if not doc or not isinstance(doc, list): continue
        for entry in doc:
            if not isinstance(entry, dict): continue
            # 顶层 entry 必须是 op 容器(insert/disable 等)——裸 id/name 顶层条目是上次崩溃根因
            if 'insert' not in entry and ('id' in entry or 'name' in entry):
                print(f"✗ 顶层裸 entry(缺 insert 容器, loader 无法定位): {entry}")
                sys.exit(1)
            if 'insert' in entry:
                for item in entry['insert']:
                    if not isinstance(item, dict): continue
                    if not item.get('id'):
                        print(f"✗ patch insert entry 缺 id: {item}")
                        sys.exit(1)
                    if not item.get('name'):
                        print(f"✗ patch insert entry {item.get('id','?')} 缺 name(loader 定位靠 name): {item}")
                        sys.exit(1)
    print("✓ patch 顶层结构校验通过")
except Exception as e:
    print(f"✗ patch YAML 解析失败: {e}")
    sys.exit(1)
PYEOF2
}

verify_all() {
  # 2026-09-08 崩溃教训: patch 格式错与插件源码改动无关联——必须无条件先校验 patch。
  # （上次崩溃: repeat-tool-reminder entry 格式错(id用包名/无insert包裹) → 88次崩溃循环）
  local failed=0
  if ! verify_patch; then failed=$((failed + 1)); fi

  log "预检最近 ${CHECK_WINDOW_MIN} 分钟内改动的插件 ..."
  local changed
  changed="$(find_changed_plugins)"
  if [ -z "$changed" ]; then
    log "  无最近改动的插件，跳过插件预检"
    if [ "$failed" -gt 0 ]; then
      die "patch 顶层结构校验失败——请先修复配置（回滚: cp cordis.patch.yml.good cordis.patch.yml）"
    fi
    log "全部预检通过"
    return 0
  fi
  local pkg
  while IFS= read -r pkg; do
    [ -n "$pkg" ] || continue
    if ! verify_plugin "$DSH_ROOT/packages/$pkg"; then failed=$((failed + 1)); fi
  done <<< "$changed"
  if [ "$failed" -gt 0 ]; then
    die "${failed} 项预检失败——请先修复源码/配置，或用 --force 强制重启（不推荐）"
  fi
  log "全部预检通过"
}

# ---------- 3. 重启 + 健康确认（失败则回滚 patch 自愈） ----------
PATCH_FILE="${PATCH_FILE:-/home/ubuntu/.dsh/profiles/web/cordis.patch.yml}"
GOOD_PATCH="${GOOD_PATCH:-/home/ubuntu/.dsh/profiles/web/cordis.patch.yml.good}"

snapshot_good_patch() {
  # 成功启动后调用：把当前（健康的）patch 存为"已知良好"快照。
  if [ -f "$PATCH_FILE" ]; then
    cp "$PATCH_FILE" "$GOOD_PATCH"
    log "已存良好 patch 快照 ($(wc -l < "$GOOD_PATCH") 行)"
  fi
}

rollback_patch() {
  # 重启失败：回滚到已知良好 patch（方向 2：保留插件、回退配置，非清空）。
  if [ -f "$GOOD_PATCH" ]; then
    cp "$GOOD_PATCH" "$PATCH_FILE"
    log "✓ 已回滚 cordis.patch.yml 到已知良好快照 ($(wc -l < "$GOOD_PATCH") 行)"
    return 0
  fi
  log "✗ 无良好 patch 快照可回滚——需人工介入"
  return 1
}

safe_restart() {
  local before_pid after_pid
  before_pid="$($CTL show "$SERVICE" -p MainPID --value 2>/dev/null || true)"
  log "重启 $SERVICE (旧 PID ${before_pid:-none}) ..."
  if ! $CTL restart "$SERVICE" 2>/tmp/dsh-safe-restart-ctl.log; then
    log "✗ 重启失败：" >&2
    cat /tmp/dsh-safe-restart-ctl.log >&2 || true
    return 1
  fi
  local waited=0 ok=0
  while [ "$waited" -lt 30 ]; do
    sleep 2; waited=$((waited + 2))
    if ! $CTL is-active --quiet "$SERVICE"; then
      log "✗ 服务未 active（重启后崩溃？），最近日志：" >&2
      journalctl --user -u "$SERVICE" --since "1 minute ago" 2>/dev/null | grep -iE "error|failed|Transform" | tail -n 10 >&2 || true
      ok=1; break
    fi
    after_pid="$($CTL show "$SERVICE" -p MainPID --value 2>/dev/null || true)"
    if [ -n "$after_pid" ] && [ "$after_pid" != "0" ] \
       && curl -fsS --max-time 3 -o /dev/null "http://127.0.0.1:3080/" 2>/dev/null; then
      ok=0; break
    fi
  done
  if [ "$ok" -eq 0 ]; then
    log "✓ 服务就绪 (PID ${after_pid})"
    snapshot_good_patch   # 成功 → 存良好快照（下次崩溃可回滚到这里）
    # v28 验证闭环: 重启后跑帧质量验证(延迟等 quiet-driver 首帧)。失败仅告警, 不阻断(回滚逻辑保持独立)。
    if [ -x "$DSH_ROOT/dsh-verify-frames.sh" ]; then
      sleep 8
      if ! "$DSH_ROOT/dsh-verify-frames.sh" --minutes 6 >/tmp/dsh-frame-verify.log 2>&1; then
        log "⚠ 帧质量验证未过(详见 /tmp/dsh-frame-verify.log)——部署后请人工确认帧产出"
        cat /tmp/dsh-frame-verify.log >&2 || true
      else
        log "✓ 帧质量验证通过($(grep -o '窗口帧数.*' /tmp/dsh-frame-verify.log | head -1))"
      fi
    fi
    return 0
  fi
  # ── 重启失败 → 自愈：回滚 patch 到已知良好快照，再试一次 ──
  log "✗ 重启失败——尝试回滚 patch 到已知良好配置后重启（方向 2：保留插件回退配置）"
  if rollback_patch; then
    if $CTL restart "$SERVICE" 2>/tmp/dsh-safe-restart-ctl2.log; then
      sleep 10
      if $CTL is-active --quiet "$SERVICE" \
         && curl -fsS --max-time 3 -o /dev/null "http://127.0.0.1:3080/" 2>/dev/null; then
        log "✓ 回滚后服务就绪 (PID $($CTL show "$SERVICE" -p MainPID --value 2>/dev/null))"
        log "  注：当前运行于回滚配置。修复问题后重跑本脚本更新良好快照。"
        return 0
      fi
    fi
  fi
  log "✗ 自愈失败——需人工介入 (journalctl --user -u $SERVICE)"
  return 1
}

# ---------- main ----------
cmd="${1:-safe}"
case "$cmd" in
  --force)
    self_awareness
    log "强制重启（跳过预检）"
    safe_restart
    ;;
  --verify-only)
    verify_all
    ;;
  --status)
    self_awareness
    log "服务状态: $($CTL is-active "$SERVICE" 2>/dev/null)"
    log "PID: $($CTL show "$SERVICE" -p MainPID --value 2>/dev/null)"
    log "NRestarts: $($CTL show "$SERVICE" -p NRestarts --value 2>/dev/null)"
    ;;
  safe|restart|"")
    self_awareness
    verify_all
    safe_restart
    ;;
  *)
    echo "用法: $0 [--force | --verify-only | --status | safe]" >&2
    exit 2
    ;;
esac
