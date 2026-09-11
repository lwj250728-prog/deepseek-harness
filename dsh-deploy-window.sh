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

# 记录通道: 部署史**永远**写 canonical 账本 $COG/deploy-log.jsonl; --log 只额外留一份。
# 起因(2026-09-11 20:0x 自查): 我几次排程部署都传了 `--log /tmp/deploy-*.log`, 于是 canonical 账本
# 停在 15:57 —— 18:08/19:40 两次真实部署在**唯一权威记录里不存在**。判据与复盘读的正是它, 于是
# "部署史"被我自己的参数悄悄改道。记录通道不该可被重定向出账本。
CANONICAL_LOG="$COG/deploy-log.jsonl"

emit() { # emit <phase> <status> [extra-json]
  # 2026-09-12 00:5x 修: 原写法 `"${3:-{}}"` 里第一个未转义的 `}` 会**提前结束参数展开** ⇒ 实际传的是
  # `<json>}` ⇒ 下游 json.loads 抛错 ⇒ 被 except 静默吞掉 ⇒ **账本 50 条 done 行从来没有 stage/
  # suiteStatus**。也就是说 cl-214「把部署成败与套件裁决分开记」的修复从未落进产物(cl-258 家族:
  # 记录通道看起来在工作, 实际一直在丢字段)。显式取变量, 不用花括号默认值。
  local _extra="${3:-}"
  [ -n "$_extra" ] || _extra='{}'
  python3 - "$CANONICAL_LOG" "$LOG" "$1" "$2" "$ORIGIN" "$DELAY" "$POST_WAIT" "$_extra" <<'PY'
import datetime, json, os, sys, socket
canonical, log, phase, status, origin, delay, postwait, extra = sys.argv[1:9]
row = {"ts": datetime.datetime.now().astimezone().isoformat(), "phase": phase, "status": status,
       "origin": origin, "delaySeconds": int(delay), "postWaitSeconds": int(postwait),
       "host": socket.gethostname(), "script": "dsh-deploy-window.sh"}
try:
    row.update(json.loads(extra))
except Exception:
    pass
line = json.dumps(row, ensure_ascii=False) + "\n"
# 干跑(既不重启也不复跑)只在调用方指定的 --log 留痕, **不写 canonical**: 否则探针/自检会把
# "部署史"灌进权威账本(T145 的"干跑不得污染生产日志"正是这条意图; 2026-09-12 00:5x 实测我自己的
# 两次 probe 就因为少了这个判断进了 canonical)。
targets = {log} if canonical == log or os.environ.get("DSH_DEPLOY_DRY") == "1" else {canonical, log}
for target in targets:
    if not target:
        continue
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "a", encoding="utf8") as f:
        f.write(line)
PY
}

if [ "$PLAN_ONLY" = 1 ]; then
  echo "计划: 等 ${DELAY}s → $([ "$SKIP_RESTART" = 1 ] && echo '(跳过重启)' || echo "$REPO/dsh-safe-restart.sh --force")"
  echo "      → 等 ${POST_WAIT}s → $([ "$SKIP_SUITE" = 1 ] && echo '(跳过复跑)' || echo "DSH_COG_ORIGIN=deploy bash $REPO/dsh-cog-tests.sh")"
  echo "记录: $LOG (plan-only 不写记录)"
  exit 0
fi

# 干跑 = 既不重启也不复跑: 由 emit 决定是否写 canonical(见 emit 里对 DSH_DEPLOY_DRY 的判断)
if [ "$SKIP_RESTART" = 1 ] && [ "$SKIP_SUITE" = 1 ]; then export DSH_DEPLOY_DRY=1; fi

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
  # cl-224: 重启成功后记录"本次进程所用产物"的内容基线。检测器据此把"仅 mtime 变新"(重建但内容
  # 逐字节相同 ⇒ 无需重启)与"内容真的变了"(需要部署)分开; 不记录的话下次重建会被保守判成待部署。
  python3 "$REPO/dsh-deploy-lib-hashes.py" --record --origin deploy-window >/dev/null 2>&1 || true
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
