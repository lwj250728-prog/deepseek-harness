#!/usr/bin/env bash
# dsh-exp253-reanchor.sh — 受控停机窗口: 修 exp_253 的错误链锚 + 清理过期粘性锚, 然后启动
#
# 为什么必须停机做(cl-030 教训): 认知管线的 experiences.jsonl 在运行时是"内存全量回写",
# 进程还持有 exp_253 的旧值, 离线改文件会被下一次 flush 覆盖。只有在服务停、进程无内存副本的
# 窗口里改, 才真正落盘。
set -uo pipefail
log() { echo "[reanchor] $*"; }

# 关键安全网: 无论中间哪一步失败, 退出时一定把服务拉起来——否则本脚本会把载体停死。
cleanup() {
  if ! systemctl --user is-active --quiet dsh-web.service; then
    log "安全网: 服务未运行, 重新启动"
    systemctl --user start dsh-web.service
  fi
  log "结束 (PID $(systemctl --user show dsh-web.service -p MainPID --value))"
}
trap cleanup EXIT

log "停止 dsh-web.service ..."
systemctl --user stop dsh-web.service

python3 - <<'PY' || log "⚠ 修正脚本失败, 由安全网恢复服务"

import json, os

base = os.path.expanduser('~/.dsh/cognitive-pipeline')
# 1) exp_253 被错误锚到已暂停的 goal-novel-60w → 改为其真实归属
p = os.path.join(base, 'experiences.jsonl')
rows = []
with open(p, encoding='utf8') as f:
    for line in f:
        line = line.strip()
        if line:
            rows.append(json.loads(line))
fixed = 0
for r in rows:
    if r.get('expId') == 'exp_253' and r.get('chainId') == 'goal-novel-60w':
        r['chainId'] = 'goal-retrieval-optimization'
        fixed += 1
with open(p, 'w', encoding='utf8') as f:
    f.write('\n'.join(json.dumps(x, ensure_ascii=False) for x in rows) + '\n')
print('[reanchor] exp_253 链锚修正: %d 行' % fixed)

# 2) 粘性锚指向非 active 目标 → 清除(cl-075 守卫的离线对应动作)
pool = {}
pp = os.path.join(base, 'dormant-goals.jsonl')
with open(pp, encoding='utf8') as f:
    for line in f:
        line = line.strip()
        if line:
            g = json.loads(line)
            if g.get('id'):
                pool[g['id']] = g.get('status')
ap = os.path.join(base, 'chain_anchors.json')
try:
    anchors = json.load(open(ap, encoding='utf8'))
except Exception:
    anchors = {}
cleared = [s for s, g in anchors.items() if pool.get(g) not in (None, 'active')]
for s in cleared:
    anchors.pop(s, None)
with open(ap, 'w', encoding='utf8') as f:
    json.dump(anchors, f, ensure_ascii=False)
print('[reanchor] 过期粘性锚清除: %s' % cleared)
PY

log "启动 dsh-web.service ..."
systemctl --user start dsh-web.service
sleep 6
systemctl --user is-active dsh-web.service
log "完成 (PID $(systemctl --user show dsh-web.service -p MainPID --value))"
