#!/usr/bin/env python3
"""dsh-deploy-intent.py — 部署意图的检测与载体核查(tp-120 / cl-189)

问题（cl-189）：重启承载着当前会话，于是"部署"永远排在"把这一轮做完"之后 —— 2026-09-11 凌晨同一个
部署被我临时手排秒数、连续改期 3 次(03:40→03:42→03:52→03:57)。T11 只守"lib 早于服务启动"这个**症状**：
它红了也没有人/机制在等；改期本身不留痕，全靠我记得。

本工具把"部署意图"变成可检测、可追责的状态：
  意图 = 任一已构建的 lib/index.js 比服务启动时间新(进程跑的不是盘上的东西)
  载体 = **排程中的 systemd 单元**(cog-deploy-*/dsh-deploy-*/dsh-restart-*)——
         判据是"它会不会在没有我的情况下自己发生"。账本项**不算载体**(它只是意图的记录, 不是载体)：
         tp-120 原计划的 (a) 单元 或 (b) 账本项 里 (b) 过弱 —— 合成实测: 当晚一直开着的 cl-189
         就足以让"无载体"永不成立, 也就是说原判据抓不住它自己要抓的那次事故。

退出码：0=无意图(无事可做) 1=有意图且有载体 2=有意图但无载体(缺陷, 需告警) 3=读数失败(自检)
--watch 模式：verdict==2 时写/刷新言行账本告警项 cl-deploy-pending（在册即饥饿可见），清空后自动关单。
--carrier-policy scheduled-or-ledger 复现"原计划的弱判据"作对照(默认 scheduled)。
"""
import argparse
import datetime
import glob
import json
import os
import subprocess
import sys
import time

LIB_GLOB = "/home/ubuntu/dsh-fork/packages/*/*/lib/index.js"
LEDGER = os.path.expanduser("~/.dsh/cognitive-pipeline/claims-ledger.jsonl")
STATE = os.path.expanduser("~/.dsh/cognitive-pipeline/deploy-intent.json")
SERVICE = "dsh-web.service"
HASH_TOOL = "/home/ubuntu/dsh-fork/dsh-deploy-lib-hashes.py"
# 排程/会话来源标记: cron 行给 DSH_COG_ORIGIN, 统一机制台账的检查器认 DSH_RUN_ORIGIN —— 两个都认,
# 免得"标了名却读不到"。落进状态文件与 watch 日志行, 便于按来源分段核验。
ORIGIN = os.environ.get("DSH_RUN_ORIGIN") or os.environ.get("DSH_COG_ORIGIN") or "manual"
UNIT_PATTERNS = ("cog-deploy", "dsh-deploy", "dsh-restart")
CARRIER_LEDGER_TTL_H = 6
TERMINAL = {"done", "retired", "closed"}


def now_iso():
    # 必须带微秒 + 冒号时区: 账本里同 id 的多行要经得起 T132 的"ts 严格递增"检查,
    # 秒级 strftime 会让"创建行"和"关单行"撞成同一个 ts(实测过), 而 +0800 与既有行的 +08:00 也不同形。
    return datetime.datetime.now().astimezone().isoformat()


def lib_max_mtime(pattern):
    files = glob.glob(pattern)
    if not files:
        return None, None
    newest = max(files, key=lambda p: os.path.getmtime(p))
    return os.path.getmtime(newest), newest


def content_state(lib_glob):
    """产物内容是否真的变了(cl-224): mtime 只是线索, 内容才是事实。

    只改客户端源码时, 构建命令会顺带重产出 host 面 lib/index.js —— 源码未动、内容逐字节相同,
    仅 mtime 变新。此时按 mtime 判"待部署"会让套件转红并推动一次毫无必要的重启。
    """
    try:
        r = subprocess.run(["python3", HASH_TOOL, "--check", "--glob", lib_glob, "--json"],
                           capture_output=True, text=True, timeout=120)
        return json.loads(r.stdout.strip() or "{}")
    except Exception as exc:  # 读不到就保守算待部署(fail-closed), 并把原因带出去
        return {"verdict": "unverifiable", "reason": "内容基线核对失败: %s" % exc}


def service_start_epoch():
    out = subprocess.run(["systemctl", "--user", "show", SERVICE, "-p", "ActiveEnterTimestamp", "--value"],
                         capture_output=True, text=True, timeout=30).stdout.strip()
    if not out:
        return None
    r = subprocess.run(["date", "-d", out, "+%s"], capture_output=True, text=True, timeout=30)
    if r.returncode != 0 or not r.stdout.strip():
        return None
    return int(r.stdout.strip())


def units_snapshot(units_file=None):
    if units_file:
        with open(units_file, encoding="utf8") as f:
            return [l.strip() for l in f if l.strip()]
    out = []
    for args in (["systemctl", "--user", "list-units", "--all", "--plain", "--no-legend"],
                 ["systemctl", "--user", "list-timers", "--all", "--plain", "--no-legend"]):
        r = subprocess.run(args, capture_output=True, text=True, timeout=30)
        out.extend(r.stdout.splitlines())
    return out


def scheduled_carriers(units_file=None):
    hits = []
    for line in units_snapshot(units_file):
        for pat in UNIT_PATTERNS:
            if pat in line:
                hits.append(line.strip()[:120])
                break
    return hits


def ledger_carriers(ledger_path, now=None):
    """未关单且 6h 内更新、且在讲部署/重启的账本项。"""
    now = now or time.time()
    if not os.path.exists(ledger_path):
        return []
    latest = {}
    for line in open(ledger_path, encoding="utf8"):
        if not line.strip():
            continue
        r = json.loads(line)
        if r.get("id"):
            latest[r["id"]] = r
    hits = []
    for rid, r in latest.items():
        if r.get("status") in TERMINAL:
            continue
        text = " ".join(str(r.get(k, "")) for k in ("claim", "note", "disposition", "nextAction"))
        if not any(w in text for w in ("部署", "重启", "restart", "deploy")):
            continue
        ts = str(r.get("ts") or "")
        try:
            age = now - time.mktime(time.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S"))
        except Exception:
            age = None
        if age is not None and age <= CARRIER_LEDGER_TTL_H * 3600:
            hits.append("%s(age=%.1fh)" % (rid, age / 3600.0))
    return hits


def raise_env_alert(n: int) -> None:
    """连续自检失败 ⇒ 写言行账本告警(不是只写日志: 日志没人读)。"""
    p = LEDGER
    rows = []
    if os.path.exists(p):
        rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
    existing = next((r for r in reversed(rows)
                     if r.get("id") == "cl-deploy-intent-env" and r.get("status") not in TERMINAL), None)
    row = dict(existing or {})
    row.update({
        "id": "cl-deploy-intent-env", "status": "open",
        "claim": "部署意图核查连续 %d 次自检失败(读不到 systemd 服务时间戳) —— 该机制在静默失效, 不是'无部署意图'" % n,
        "source": "dsh-deploy-intent.py 自检",
        "reviewBy": time.strftime("%Y-%m-%d", time.localtime(time.time() + 86400)),
    })
    row["ts"] = now_iso()
    with open(p, "a", encoding="utf8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def close_env_alert() -> None:
    p = LEDGER
    if not os.path.exists(p):
        return
    rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
    open_row = next((r for r in reversed(rows)
                     if r.get("id") == "cl-deploy-intent-env" and r.get("status") not in TERMINAL), None)
    if open_row is None:
        return
    row = dict(open_row)
    row.update({"status": "done", "doneNote": "自检已恢复(能读到服务时间戳)", "ts": now_iso()})
    with open(p, "a", encoding="utf8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def write_alert(message):
    rows = []
    if os.path.exists(LEDGER):
        rows = [json.loads(l) for l in open(LEDGER, encoding="utf8") if l.strip()]
    existing = next((r for r in reversed(rows) if r.get("id") == "cl-deploy-pending"
                     and r.get("status") not in TERMINAL), None)
    row = dict(existing or {})
    row.update({
        "id": "cl-deploy-pending", "status": "open", "claim": message,
        "source": "dsh-deploy-intent.py --watch",
        "reviewBy": time.strftime("%Y-%m-%d", time.localtime(time.time() + 86400)),
    })
    row["ts"] = now_iso()
    with open(LEDGER, "a", encoding="utf8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")
    return existing is not None


def close_alert():
    rows = [json.loads(l) for l in open(LEDGER, encoding="utf8") if l.strip()] if os.path.exists(LEDGER) else []
    open_row = next((r for r in reversed(rows) if r.get("id") == "cl-deploy-pending"
                     and r.get("status") not in TERMINAL), None)
    if open_row is None:
        return False
    row = dict(open_row)
    row.update({"status": "done", "doneNote": "部署意图已消解(lib 已不新于服务启动)", "ts": now_iso()})
    with open(LEDGER, "a", encoding="utf8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--state", default=STATE)
    ap.add_argument("--ledger", default=LEDGER)
    ap.add_argument("--lib-glob", default=LIB_GLOB)
    ap.add_argument("--units-file", default=None, help="合成单元清单(测试用; 不给则问 systemctl)")
    ap.add_argument("--lib-ts", type=float, default=None, help="覆盖 lib 时间戳(测试用)")
    ap.add_argument("--service-ts", type=float, default=None, help="覆盖服务启动时间戳(测试用)")
    ap.add_argument("--watch", action="store_true", help="verdict==2 时写/刷新账本告警")
    ap.add_argument("--carrier-policy", choices=("scheduled", "scheduled-or-ledger"), default="scheduled",
                    help="scheduled(默认, 严格: 只有排程单元算载体) / scheduled-or-ledger(原计划的弱判据)")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    lib_ts, lib_path = lib_max_mtime(args.lib_glob)
    svc_ts = service_start_epoch()
    if args.lib_ts is not None:
        lib_ts, lib_path = args.lib_ts, lib_path or "(合成)"
    if args.service_ts is not None:
        svc_ts = args.service_ts
    if lib_ts is None or svc_ts is None:
        # cl-213(2026-09-11 10:0x): 这条自检失败**每 5 分钟**写进 deploy-intent-watch.log, 但没有任何人/机制读它
        # —— 实测从 07:5x 起连续失败数小时(cron 环境没有 systemd user 会话 ⇒ systemctl --user "Failed to connect to bus"),
        # 于是"部署意图核查"整条机制静默失效。现在: 连续失败达阈值就写言行账本告警(帧自查可见), 恢复后自动关单。
        fails = os.path.join(os.path.dirname(args.state), "deploy-intent-env-fails")
        n = 0
        try:
            n = int(open(fails, encoding="utf8").read().strip() or 0) + 1
        except Exception:
            n = 1
        open(fails, "w", encoding="utf8").write(str(n))
        print("[deploy-intent] 自检失败(第 %d 次): lib_ts=%s svc_ts=%s(读不到) "
              "—— 多半是运行环境没有 systemd user 会话(cron 缺 XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS)"
              % (n, lib_ts, svc_ts), file=sys.stderr)
        if n >= 3:
            raise_env_alert(n)
        return 3
    # 自检恢复正常 ⇒ 清零计数并关闭遗留告警
    try:
        os.remove(os.path.join(os.path.dirname(args.state), "deploy-intent-env-fails"))
    except Exception:
        pass
    close_env_alert()

    mtime_newer = lib_ts >= svc_ts
    # 合成时间戳(测试/探针)不做内容比对: 那些世界里的产物就是现场的, 比对只会把判据本身测模糊。
    content = {"verdict": "skipped", "reason": "合成时间戳, 不做内容比对"} if args.lib_ts is not None \
        else content_state(args.lib_glob)
    pending = bool(mtime_newer and content.get("verdict") != "identical")
    sched = scheduled_carriers(args.units_file) if pending else []
    ledg = ledger_carriers(args.ledger) if pending else []
    carried = bool(sched) or (args.carrier_policy == "scheduled-or-ledger" and bool(ledg))
    if not pending:
        verdict, code = "no-intent", 0
    elif carried:
        verdict, code = "carried", 1
    else:
        verdict, code = "uncarried", 2

    state = {
        "ts": now_iso(), "origin": ORIGIN, "pending": pending, "verdict": verdict,
        "carrierPolicy": args.carrier_policy,
        "libTs": lib_ts, "libPath": lib_path, "serviceStartTs": svc_ts,
        "mtimeNewer": mtime_newer, "contentVerdict": content.get("verdict"),
        "contentReason": content.get("reason"), "hashBaselineTs": content.get("baselineTs"),
        "driftSeconds": int(lib_ts - svc_ts) if pending else int(svc_ts - lib_ts),
        "scheduledCarriers": sched, "ledgerMentions": ledg,
    }
    with open(args.state, "w", encoding="utf8") as f:
        json.dump(state, f, ensure_ascii=False, indent=1)

    if args.watch and code == 2:
        refreshed = write_alert("部署意图无人承载: 已构建 lib 比服务启动新 %d 秒, 既无排程单元"
                                "(cog-deploy-*/dsh-deploy-*/dsh-restart-*)——账本项不算载体(它只是意图的记录, "
                                "不是会自己发生的载体): 部署永远排在'把这一轮做完'之后就是这个缺口(cl-189)"
                                % state["driftSeconds"])
        state["alertWritten"] = "refreshed" if refreshed else "created"
        with open(args.state, "w", encoding="utf8") as f:
            json.dump(state, f, ensure_ascii=False, indent=1)
    elif args.watch and code != 2:
        if close_alert():
            state["alertClosed"] = True
            with open(args.state, "w", encoding="utf8") as f:
                json.dump(state, f, ensure_ascii=False, indent=1)

    if not args.quiet:
        print("[deploy-intent] verdict=%s policy=%s pending=%s drift=%ds scheduled=%d ledgerMentions=%d"
              % (verdict, args.carrier_policy, pending, state["driftSeconds"], len(sched), len(ledg)))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
