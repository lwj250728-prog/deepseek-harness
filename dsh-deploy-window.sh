#!/usr/bin/env bash
# dsh-deploy-window.sh — 延迟部署窗口(版本化, tp-123 / cl-189)
#
# 为什么需要它: 2026-09-11 凌晨的两次延迟部署用的是 /tmp/dsh-post-deploy*.sh —— 重启命令、等待时长、
# 复跑套件的顺序都没进版本库, 也没进机制台账: 事后无法复现"那次部署到底做了什么", /tmp 一清证据就没了。
# 本脚本把这些固化成可复现、可核验、留持久记录的一个动作。
#
# 用法:
#   dsh-deploy-window.sh --plan-only                 # 只打印计划, 不动服务、不写记录
#   dsh-deploy-window.sh                             # 默认: 等 60s → 安全重启 → 等 90s → 复跑套件
#   dsh-deploy-window.sh --delay-seconds 300         # 给自己的回合留出时间(重启会掐断当前会话)
#   dsh-deploy-window.sh --skip-restart --log /tmp/x.jsonl   # 干跑: 只验证记录路径(测试用)
#
# 排程(载体必须是"会自己发生"的东西, 见 dsh-deploy-intent.py):
#   systemd-run --user --on-active=<秒> --unit=cog-deploy-<tag> --collect \
#       /home/ubuntu/dsh-fork/dsh-deploy-window.sh --delay-seconds 0
#
# 每次运行都往 deploy-log.jsonl 追加一条持久记录(start/done/failed + 套件通过数), 这样
# "那次部署做了什么、成没成" 由磁盘回答, 不由记忆回答。
set -uo pipefail

REPO=/home/ubuntu/dsh-fork
COG="${DSH_COG_DIR:-$HOME/.dsh/cognitive-pipeline}"
DELAY=60
POST_WAIT=90
LOG="$COG/deploy-log.jsonl"
SKIP_RESTART=0
SKIP_SUITE=0
PLAN_ONLY=0
ORIGIN="${DSH_RUN_ORIGIN:-${DSH_COG_ORIGIN:-manual}}"

while [ $# -gt 0 ]; do
  case "$1" in
    --delay-seconds) DELAY="${2:?}"; shift 2 ;;
    --post-wait) POST_WAIT="${2:?}"; shift 2 ;;
    --log) LOG="${2:?}"; shift 2 ;;
    --skip-restart) SKIP_RESTART=1; shift ;;
    --skip-suite) SKIP_SUITE=1; shift ;;
    --plan-only) PLAN_ONLY=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

emit() { # emit <phase> <status> [extra-json]
  python3 - "$LOG" "$1" "$2" "$ORIGIN" "$DELAY" "$POST_WAIT" "${3:-{}}" <<'PY'
import datetime, json, os, sys, socket
log, phase, status, origin, delay, postwait, extra = sys.argv[1:8]
row = {"ts": datetime.datetime.now().astimezone().isoformat(), "phase": phase, "status": status,
       "origin": origin, "delaySeconds": int(delay), "postWaitSeconds": int(postwait),
       "host": socket.gethostname(), "script": "dsh-deploy-window.sh"}
try:
    row.update(json.loads(extra))
except Exception:
    pass
os.makedirs(os.path.dirname(log), exist_ok=True)
with open(log, "a", encoding="utf8") as f:
    f.write(json.dumps(row, ensure_ascii=False) + "\n")
PY
}

if [ "$PLAN_ONLY" = 1 ]; then
  echo "计划: 等 ${DELAY}s → $([ "$SKIP_RESTART" = 1 ] && echo '(跳过重启)' || echo "$REPO/dsh-safe-restart.sh --force")"
  echo "      → 等 ${POST_WAIT}s → $([ "$SKIP_SUITE" = 1 ] && echo '(跳过复跑)' || echo "DSH_COG_ORIGIN=deploy bash $REPO/dsh-cog-tests.sh")"
  echo "记录: $LOG (plan-only 不写记录)"
  exit 0
fi

emit start running "{\"pid\": $$}"
sleep "$DELAY"

if [ "$SKIP_RESTART" != 1 ]; then
  if ! "$REPO/dsh-safe-restart.sh" --force; then
    emit done failed '{"stage": "restart"}'
    exit 1
  fi
  # 只有真的重启过才需要等服务起来; 干跑(--skip-restart)不该白等 90 秒
  # (实测踩过: 干跑被 60s 超时杀掉, 记录只写了一半 —— 干跑必须快)。
  sleep "$POST_WAIT"
fi

if [ "$SKIP_SUITE" != 1 ]; then
  DSH_COG_ORIGIN=deploy bash "$REPO/dsh-cog-tests.sh" >/dev/null 2>&1
  SUITE_EXIT=$?
  VERDICT="$(grep -o '累计裁决: [0-9]* 通过 / [0-9]* 失败' "$COG/.cog-tests.log" 2>/dev/null | tail -1)"
  # cl-214: status 只描述**部署本身**。原先套件红就写 status=failed, 于是台账上"最近四次部署全失败",
  # 而事实是四次重启都成功了、只是套件当时有真红 —— 把两件事混成一个字段会让台账撒谎。
  # 套件结果单独放 suiteStatus, 不改写部署的成败。
  emit done ok "{\"stage\": \"suite\", \"suiteStatus\": \"$([ "$SUITE_EXIT" -eq 0 ] && echo green || echo red)\", \"suiteExit\": $SUITE_EXIT, \"verdict\": \"${VERDICT:-unknown}\"}"
  exit 0
fi

emit done ok '{"stage": "no-suite"}'
exit 0
