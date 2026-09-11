#!/usr/bin/env python3
"""dsh-deploy-boundary.py — 部署边界(判据该从哪一刻起算)的唯一实现

问题(2026-09-11 08:0x 测试审视帧实测): 多个判据用 `lib/index.js 的 mtime` 划部署边界,
但"构建完成"与"新进程跑起来"之间存在窗口(实测 07:52 构建、07:58:50 才重启)。窗口内的审计行
是**旧进程**写的 —— 拿它们当"部署后的行为"会误判: T147 就因为一条 07:55 的 injected 行缺 preTop
而差点判红, 而那条行其实出自旧代码。

正确边界 = max(lib 构建时刻, 服务启动时刻): 两个都满足之后写下的行, 才一定出自新代码。

用法:
  python3 dsh-deploy-boundary.py [--lib P] [--service dsh-web.service] [--json]
输出: 毫秒时刻(默认纯数字, 便于 shell 取值); --json 给出分解与依据。
"""
import argparse
import datetime
import json
import os
import subprocess
import sys

DEFAULT_LIB = os.path.expanduser("~/dsh-fork/packages/context/cognitive-inject/lib/index.js")


def lib_mtime_ms(path: str) -> int:
    return int(os.path.getmtime(path) * 1000) if os.path.exists(path) else 0


def service_start_ms(service: str) -> int:
    out = subprocess.run(["systemctl", "--user", "show", service, "-p", "ActiveEnterTimestamp", "--value"],
                         capture_output=True, text=True, timeout=30).stdout.strip()
    if not out:
        return 0
    r = subprocess.run(["date", "-d", out, "+%s"], capture_output=True, text=True, timeout=30)
    if r.returncode != 0 or not r.stdout.strip():
        return 0
    return int(r.stdout.strip()) * 1000


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lib", default=DEFAULT_LIB)
    ap.add_argument("--service", default="dsh-web.service")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    lib = lib_mtime_ms(args.lib)
    svc = service_start_ms(args.service)
    after = max(lib, svc)
    if args.json:
        print(json.dumps({
            "after": after,
            "libMtime": lib,
            "serviceStart": svc,
            "boundary": "service" if svc >= lib else "lib",
            "note": "两者取较晚者: 只有它之后写下的行才一定出自新代码",
        }, ensure_ascii=False))
    else:
        print(after)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
