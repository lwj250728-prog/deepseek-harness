#!/usr/bin/env bash
# dsh-guard-t222-probe.sh — T222「开火探针必须双臂可区分」的开火探针(**双臂**)
# 语义: 造一个**单臂**探针(忽略 DSH_PROBE_CLEAN, 两个环境下都退 1)并把它登记进**合成登记簿**,
#       再让 T222 的判据去读 —— 判据必须判红(新单臂 ⇒ 拒绝)。
#   exit 1 = FIRED / exit 4 = 漂移 / exit 3 = 探针自身失效 / exit 0 = 干净臂
set -uo pipefail
CLEAN="${DSH_PROBE_CLEAN:-}"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
# 合成世界: 登记簿 + 冻基线(空) + 一条单臂探针
cat > "$TMP/single.sh" <<'P'
#!/usr/bin/env bash
exit 1
P
python3 - "$TMP" <<'MK' || exit 3
import json, os, sys
T = sys.argv[1]
reg = {"guards": [{"guard": "T999", "mustFire": [
    {"assertion": "阶段总结帧必须真的产出总结与外部分(且外部分不得空口给分)",
     "command": "bash -c exit 1", "expectedExit": 1,
     "arms": {"mutant": 1, "clean": 1}}]}]}
json.dump(reg, open(os.path.join(T, "guard-fire.json"), "w", encoding="utf8"), ensure_ascii=False)
json.dump({"at": "2026-09-13T12:00:00+08:00", "frozenSingleArm": [], "twoArmCount": 0,
           "reason": "合成"}, open(os.path.join(T, "probe-arms-baseline.json"), "w", encoding="utf8"), ensure_ascii=False)
MK
if [ "$CLEAN" = "1" ]; then
  # 干净臂: 把合成登记簿里的 arms 改成**双臂**再跑 → 判据应绿
  python3 - "$TMP" <<'MK' || exit 3
import json, os, sys
T = sys.argv[1]
reg = json.load(open(os.path.join(T, "guard-fire.json"), encoding="utf8"))
# 用真实的 T217 探针(它双臂可区分)作为"干净的合成登记簿"内容
reg["guards"][0]["mustFire"][0]["command"] = "bash /home/ubuntu/dsh-fork/dsh-guard-t217-probe.sh"
reg["guards"][0]["mustFire"][0]["arms"] = {"mutant": 1, "clean": 0}
reg["guards"][0]["guard"] = "T217"
json.dump(reg, open(os.path.join(T, "guard-fire.json"), "w", encoding="utf8"), ensure_ascii=False)
MK
  if DSH_COG_DIR="$TMP" python3 /home/ubuntu/dsh-fork/dsh-assert-runner.py \
       --name "开火探针必须双臂可区分(arms 实测填入, 抽样复核一致, 新增不许单臂)" >/dev/null 2>&1; then
    echo "[guard-fire] T222 干净臂: 双臂登记簿被判绿(应然)" >&2
    exit 0
  fi
  echo "干净臂被判红 —— 判据在正常登记簿上也红, 对变异无区分力" >&2
  exit 3
fi
if DSH_COG_DIR="$TMP" python3 /home/ubuntu/dsh-fork/dsh-assert-runner.py \
     --name "开火探针必须双臂可区分(arms 实测填入, 抽样复核一致, 新增不许单臂)" >/dev/null 2>&1; then
  echo "新的单臂探针被放行 —— 双臂门槛形同虚设" >&2
  exit 4
fi
echo "[guard-fire] FIRED T222: 新单臂探针被拒(登记前必须让干净臂退出 0)" >&2
exit 1
