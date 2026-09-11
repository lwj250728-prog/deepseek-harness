#!/usr/bin/env bash
# dsh-guard-t181-probe.sh — T181「自动修补触发必须可达」的开火探针(cl-259)
#
# 语义：把阈值换成一个**不可达**的值，判据必须判红(而不是继续安静地绿)。
#   exit 1 = 开火(判据抓得住"死分支") ← must-fire 约定的期望码
#   exit 4 = 判据在不可达阈值下仍然放行(即判据自身是死的) —— 这正是 cl-259 的病灶形态
# 同时对照一次**发布中的默认值**：同一回放用源码默认阈值必须判绿，
# 否则探针本身恒红、"开火"就不再有信息量。
#
# 为什么这条探针必须存在：cl-259 的教训是"分支看起来在工作、实际永不执行"。
# 判据若不验证自己的可开火性，就会用同一种方式再死一次。
set -uo pipefail
python3 - <<'PYEOF'
import json, os, re, subprocess, sys, tempfile

root = os.path.expanduser("~/dsh-fork")
src = open(os.path.join(root, "packages/cognition/cognitive-pipeline/src/service.ts"), encoding="utf8").read()


def default_num(field, cast=float):
    m = re.search(field + r": z\.number\(\)[^,]*\.default\(([0-9.]+)\)", src)
    if not m:
        print("找不到 " + field + " 的默认值", file=sys.stderr)
        sys.exit(4)
    return cast(m.group(1))


win = default_num("driftWindowSize", int)
hi = default_num("driftMeanErrorThreshold")
lo = default_num("driftDisarmErrorThreshold")
emerg = default_num("emergencyErrorThreshold")

tmp = tempfile.mkdtemp()
script = os.path.join(tmp, "probe.mts")
out = os.path.join(tmp, "out.json")
open(script, "w", encoding="utf8").write(f"""
import {{ readFileSync, writeFileSync }} from "node:fs"
import {{ evaluateDriftTrigger }} from "{root}/packages/cognition/cognitive-pipeline/src/service.ts"
const rows = new Map<string, any>()
for (const line of readFileSync("/home/ubuntu/.dsh/cognitive-pipeline/predictions.jsonl", "utf8").split("\\n")) {{
  if (!line.trim()) continue
  const o = JSON.parse(line)
  rows.set(o.predictionId, o)
}}
const settled: number[] = [...rows.values()]
  .filter((p: any) => p.predictionError !== null)
  .sort((a: any, b: any) => (a.resolvedAt ?? 0) - (b.resolvedAt ?? 0))
  .map((p: any) => Math.abs(p.predictionError))
function replay(cfg: any) {{
  let armed = true, fires = 0
  for (let i = 0; i < settled.length; i++) {{
    const d = evaluateDriftTrigger(settled.slice(0, i + 1), armed, cfg)
    armed = d.armed
    if (d.fire) fires++
  }}
  return fires
}}
writeFileSync(process.argv[2], JSON.stringify({{
  shipped: replay({{ windowSize: {win}, meanThreshold: {hi}, disarmThreshold: {lo} }}),
  poisoned: replay({{ windowSize: {win}, meanThreshold: 0.9, disarmThreshold: {lo} }}),
  emergencyShipped: settled.filter(e => e >= {emerg}).length,
  emergencyPoisoned: settled.filter(e => e >= 0.95).length,
  n: settled.length,
}}))
""")
r = subprocess.run(["npx", "tsx", script, out], cwd=root, capture_output=True, text=True, timeout=600)
if r.returncode != 0:
    print("探针脚本失败: " + (r.stderr or r.stdout)[-200:], file=sys.stderr)
    sys.exit(4)
d = json.loads(open(out, encoding="utf8").read())
print("发布默认: drift=%d emergency=%d | 毒化阈值: drift=%d emergency=%d | n=%d"
      % (d["shipped"], d["emergencyShipped"], d["poisoned"], d["emergencyPoisoned"], d["n"]), file=sys.stderr)
fired = d["poisoned"] == 0 and d["emergencyPoisoned"] == 0
control_ok = d["shipped"] >= 1 and d["emergencyShipped"] >= 1 and d["n"] >= 100
if fired and control_ok:
    sys.exit(1)   # 开火: 不可达阈值被判红, 发布默认被判绿
print("判据行为不符(毒化后仍放行=%s / 对照未过=%s)" % (not fired, not control_ok), file=sys.stderr)
sys.exit(4)
PYEOF
