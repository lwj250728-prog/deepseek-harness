#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-collection-fingerprint.py — 把"采集方式"钉成一个可核的指纹(tp-191)。

问题: `citation-era.json` 记录了"引用率的采集方式在 09-10 前后变了"这件事, 但那是**一段叙述**。若采集方式
**再变一次**(契约措辞、结算判据、TTL 改一行), 没有任何东西会响 —— 时代文件不变、消费方照常出数, 于是
"跨时代平均"会以更隐蔽的方式回来(这次连"缺时代"这个红灯都不亮)。

做法: 对**承载采集语义的源码片段**取 sha256, 写进 era 文件; 判据(--check)重算并比对, 不符即判红并提示
"要么回退, 要么更新 era 并追认新起点"。三块片段(全部按**标记**抽取, 不按行号 —— 行号会随无关改动漂移):

  ① inject 侧**引用契约文本**(`citationContract`): 它决定"什么算被引用"这件事对模型怎么说;
  ② pipeline 侧**结算判据**(`mentioned = record.expIds.some(...)` 到 `settleInjection(..., mentioned)`):
     它决定"从回复文本里怎么读出一个引用";
  ③ 结算 TTL 常量: 它决定"未结算何时按未引用结算", 直接改变 cited 的可观测时刻。

任何一块的**标记消失** ⇒ exit 3(那本身就是采集代码变了, 不能静默当"找不到就跳过")。
用法: dsh-collection-fingerprint.py [--print|--write|--check] [--json]
     变异探针可用 DSH_FP_INJECT_SRC / DSH_FP_SETTLE_SRC 指向**改过的副本**(不碰真源码)。
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import re
import sys

REPO = os.environ.get('DSH_REPO') or os.path.expanduser('~/dsh-fork')
TZ = datetime.timezone(datetime.timedelta(hours=8))
INJECT_SRC = os.environ.get('DSH_FP_INJECT_SRC') or os.path.join(
    REPO, 'packages/context/cognitive-inject/src/index.ts')
SETTLE_SRC = os.environ.get('DSH_FP_SETTLE_SRC') or os.path.join(
    REPO, 'packages/cognition/cognitive-pipeline/src/service.ts')

FRAGMENTS = (
    # (名字, 文件, 起始标记, 结束标记(不含))
    ('citation-contract-inject', INJECT_SRC, 'const citationContract = ',
     '  const text = '),
    ('citation-settlement-predicate', SETTLE_SRC, 'const mentioned = record.expIds.some(',
     'this.store.settleInjection(record.injectionId, mentioned)'),
    ('settlement-ttl-const', SETTLE_SRC, 'INJECTION_SETTLE_TTL_MS =', '\n'),
)


def extract(path: str, start: str, end: str) -> str | None:
    try:
        text = open(path, encoding='utf8').read()
    except OSError:
        return None
    i = text.find(start)
    if i < 0:
        return None
    j = text.find(end, i + len(start))
    if j < 0:
        j = min(len(text), i + 4000)
    chunk = text[i:j]
    return '\n'.join(line.rstrip() for line in chunk.split('\n'))


def fingerprint() -> tuple[str | None, dict, str]:
    """→ (总指纹, 各片段信息, 失败原因)。任一标记抽取不到 ⇒ 指纹为 None。"""
    parts, info = [], {}
    for name, path, start, end in FRAGMENTS:
        chunk = extract(path, start, end)
        if chunk is None or chunk.strip() == '':
            return None, info, '片段 %s 抽不到(标记 %r 在 %s 里找不到了)' % (name, start, os.path.basename(path))
        h = hashlib.sha256(chunk.encode('utf8')).hexdigest()
        parts.append('%s:%s' % (name, h))
        info[name] = {'sha256': h[:16], 'bytes': len(chunk.encode('utf8')),
                      'source': os.path.relpath(path, os.path.expanduser('~'))}
    total = hashlib.sha256('\n'.join(parts).encode('utf8')).hexdigest()
    return total, info, ''


def era_path() -> str:
    d = os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')
    return os.path.join(d, 'citation-era.json')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--print', dest='do_print', action='store_true')
    ap.add_argument('--write', action='store_true')
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()
    if not (args.do_print or args.write or args.check):
        args.check = True

    fp, info, why = fingerprint()
    if fp is None:
        print('[fingerprint] 采集代码读不出来/标记找不到: %s ⇒ fail-closed(标记消失本身就是采集方式变了)' % why,
              file=sys.stderr)
        return 3

    p = era_path()
    if args.write:
        if not os.path.exists(p):
            print('[fingerprint] 缺 era 文件: %s' % p, file=sys.stderr)
            return 3
        era = json.load(open(p, encoding='utf8'))
        era['collectionFingerprint'] = fp
        era['fingerprintAt'] = datetime.datetime.now(TZ).isoformat()
        era['fingerprintFragments'] = info
        era['fingerprintNote'] = ('三块片段: ①inject 侧引用契约文本 ②结算判据(怎么从回复文本读出引用) '
                                  '③结算 TTL 常量。任一块变了 ⇒ dsh-collection-fingerprint.py --check 判红, '
                                  '并要求"要么回退, 要么更新 era 并追认新起点"。')
        tmp = p + '.tmp'
        with open(tmp, 'w', encoding='utf8') as fh:
            json.dump(era, fh, ensure_ascii=False, indent=1)
            fh.flush()
            os.fsync(fh.fileno())
        if os.path.exists(p):
            os.chmod(tmp, os.stat(p).st_mode & 0o7777)
        os.replace(tmp, p)
        print('[fingerprint] 已写入 %s: %s' % (p, fp[:16]))
        return 0

    if args.do_print:
        print('[fingerprint] 当前采集指纹 %s' % fp)
        for k, v in info.items():
            print('   %-32s %s (%d 字节, %s)' % (k, v['sha256'], v['bytes'], v['source']))
        if args.json:
            print(json.dumps({'fingerprint': fp, 'fragments': info}, ensure_ascii=False))
        return 0

    # --check
    if not os.path.exists(p):
        print('[fingerprint] 缺 era 文件: %s ⇒ 判红(没有声明就谈不上"声明与代码一致")' % p, file=sys.stderr)
        return 1
    era = json.load(open(p, encoding='utf8'))
    declared = str(era.get('collectionFingerprint') or '')
    if not declared:
        print('[fingerprint] era 里没有 collectionFingerprint ⇒ 判红(时代声明没绑定采集代码, '
              '采集方式再变时无人报警)。修法: python3 dsh-collection-fingerprint.py --write', file=sys.stderr)
        return 1
    if declared != fp:
        print('[fingerprint] **采集方式变了**: era 声明 %s, 实测 %s ⇒ 要么回退代码, 要么更新 era 并追认新起点'
              '(注意: 更新 era 等于承认"这之前的读数与新读数不可比")' % (declared[:16], fp[:16]), file=sys.stderr)
        for k, v in info.items():
            old = (era.get('fingerprintFragments') or {}).get(k) or {}
            if old.get('sha256') and old['sha256'] != v['sha256']:
                print('   · 变了: %s (%s → %s)' % (k, old['sha256'], v['sha256']), file=sys.stderr)
        return 1
    print('[fingerprint] 采集指纹一致(%s), 采集代码未变' % fp[:16])
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
