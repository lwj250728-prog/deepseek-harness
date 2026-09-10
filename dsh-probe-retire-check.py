#!/usr/bin/env python3
"""cl-100 临时探针退场守卫（tp-064 / T81）。

诊断期的临时探针最危险的死法不是它出错，而是它"没人敢删"：开始写文件、被别的
脚本当数据源、最后变成事实上的永久机制。更隐蔽的一种是**删掉数据文件、留下写它的
代码**——所以本守卫的判据落在"代码里还有没有探针"，而不是"有没有那个 jsonl"。

期限锚点（取最晚的一个，且必须至少存在一个）：
  ① settle-debug.jsonl 首条记录的 t（探针真正开始工作的时刻，不随 mtime 漂移）
  ② cl-100-diagnosis.md 里的 `probe-deadline: <ISO>` 行（数据文件删了也还在的书面期限）

到期后必须同时满足：
  ① settle-debug.jsonl 不再存在
  ② 探针代码已移除：lib 不再含 'settle-debug.jsonl'，src 不再含 'cl-100 PROBE'

无任何锚点却仍在代码里发现探针 → 直接红（"无退场期限的临时物"本身就是违规）。
未到期时空过（exit 0），只打印剩余时间。

用法：
    dsh-probe-retire-check.py [--root DIR] [--lib PATH] [--src PATH] [--now MS]
退出码：0 = 空过或已按计划退场；1 = 红。
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import sys
import time

TTL_MS = 24 * 60 * 60 * 1000
SRC_MARKER = 'cl-100 PROBE'
LIB_MARKER = 'settle-debug.jsonl'


def read_text(path: str) -> str | None:
    if not os.path.exists(path):
        return None
    with open(path, encoding='utf8', errors='replace') as fh:
        return fh.read()


def probe_first_ts(path: str) -> int | None:
    text = read_text(path)
    if text is None:
        return None
    stamps: list[int] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            stamp = json.loads(line).get('t')
        except Exception:
            continue
        if isinstance(stamp, int):
            stamps.append(stamp)
    return min(stamps) if stamps else None


def lower_index(line: str, marker: str) -> int:
    """Case-insensitive index of marker in line."""
    return line.lower().index(marker)


def deadline_anchor(root: str):
    """Read the written deadline from the diagnosis report, when present.

    → (found, ts_ms)：found 表示**文件里有没有 probe-deadline 行**，ts_ms 是解析结果(None=解析失败)。
    实测教训(2026-09-11 05:1x)：原实现把"没有期限行"和"期限行解析不出来"都返回 None, 于是格式一坏
    (ISO 令牌后面紧跟括号没有空格 → raw.split()[0] 把中文括号吞进 token)就**静默回退到另一个锚点**
    (探针首条记录的 t), 判出一个"超期 24.1h"的红——看着像探针过期, 其实是解析失败。
    与 T11 的修法同族：缺证据必须说出来, 不能伪装成另一种判定。
    """
    text = read_text(os.path.join(root, 'cl-100-diagnosis.md'))
    if text is None:
        return False, None
    for line in text.splitlines():
        marker = 'probe-deadline:'
        if marker not in line.lower():
            continue
        raw = line[lower_index(line, marker) + len(marker):].strip()
        token = raw.split()[0].rstrip('，。；,;') if raw.split() else ''
        try:
            return True, int(datetime.datetime.fromisoformat(token).timestamp() * 1000)
        except Exception:
            return True, None
    return False, None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', default=os.path.expanduser('~/.dsh/cognitive-pipeline'))
    parser.add_argument('--lib', default=os.path.expanduser(
        '~/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js'))
    parser.add_argument('--src', default=os.path.expanduser(
        '~/dsh-fork/packages/cognition/cognitive-pipeline/src/service.ts'))
    parser.add_argument('--now', type=int, default=None)
    args = parser.parse_args()

    now = args.now if args.now is not None else int(time.time() * 1000)
    probe = os.path.join(args.root, 'settle-debug.jsonl')

    lib_text = read_text(args.lib)
    src_text = read_text(args.src)
    lib_has = lib_text is not None and LIB_MARKER in lib_text
    src_has = src_text is not None and SRC_MARKER in src_text
    present = lib_has or src_has

    found, written = deadline_anchor(args.root)
    if found and written is None:
        # 有期限行却解析不出来：这是"缺证据", 不许静默回退到另一个锚点去判真假。
        print('红：cl-100-diagnosis.md 有 probe-deadline 行但无法解析出时刻'
              '（缺证据不得当成"用别的锚点"——ISO 令牌后请留一个空格再写说明）', file=sys.stderr)
        return 1

    anchors = [ts for ts in (probe_first_ts(probe), written) if ts is not None]

    if not anchors:
        if present:
            where = ' '.join([w for w, hit in (('lib', lib_has), ('src', src_has)) if hit])
            print('红：代码里仍有探针，但找不到任何退场期限锚点（%s）——临时物必须带期限' % where,
                  file=sys.stderr)
            return 1
        print('空过：无探针、无锚点（从未上线或已彻底退场）')
        return 0

    deadline = max(anchors)
    stamp = datetime.datetime.fromtimestamp(deadline / 1000).strftime('%Y-%m-%d %H:%M:%S')
    if now <= deadline:
        print('空过：探针未到期，剩余 %.1fh（期限 %s）' % ((deadline - now) / 3600000, stamp))
        return 0

    problems: list[str] = []
    if os.path.exists(probe):
        problems.append('settle-debug.jsonl 仍在')
    if lib_has:
        problems.append("lib 仍含 '%s'" % LIB_MARKER)
    if src_has:
        problems.append("src 仍含 '%s'" % SRC_MARKER)
    if lib_text is None:
        problems.append('lib 不可读：无法判定探针代码是否移除（fail-closed）')

    if problems:
        print('红：探针超期 %.1fh 未退场——%s' % ((now - deadline) / 3600000, '；'.join(problems)),
              file=sys.stderr)
        return 1
    print('通过：探针已按计划退场（超期 %.1fh，期限 %s）' % ((now - deadline) / 3600000, stamp))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
