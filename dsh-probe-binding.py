#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-probe-binding.py — 双臂探针的**有效性绑定**(tp-200 / 判据组 T230)。

问题(2026-09-13 实测):
  `guard-fire.json` 的 mustFire 只绑**命令**(`probe-arms-baseline.json` 顶层只有 at/twoArmCount),
  没有任何 per-probe 记录 —— 不记录探针**变异了哪个片段**、**验证的是哪一版判据体**。于是:
    (a) **锚点漂移**: 探针靠 `assert s.count(old) == 1` 找落点, 源码被重构(尤其**并发会话改同一批文件**)时
        探针 exit 3「自身失效」; 若没人看 arms 输出, 这条判据的探针就成了**没人知道的空壳**。
    (b) **等价变异**: 变异落点变成行为等价(今天 T229 第一版合成世界: 那条 ✗ 距文件尾不足 400 行 ⇒
        变异没改变任何东西, 探针 exit 4)。「变异落盘」被验证过, 「变异有区分力」从没被机制记录过。
    (c) **干净臂红**: T226 今天因另一会话改了 handover.spec.ts 而判红 ⇒ arms 检查只报
        `异常: other(变异臂 1 / 干净臂 3)`; 裁决存在, 但**没写进登记簿** ⇒ 读的人无从分辨 two-arm 与 other。

本工具把三条绑成 machine-checkable:
  ① 每条探针登记 `anchors:[{file, fragment, sha256}]` + `bodySha256`(它验证的判据体) + `verifiedAt` + `verdict`;
  ② `--check` 断言 (a) 每个锚点在目标文件里仍存在且**唯一**(count == 1), 否则红并打印「锚点漂移: 探针已失效」;
  ③ 断言 (b) 判据体当前 sha256 == 登记值, 或 `verifiedAt` 晚于体文件 mtime(体改了但**已重验**), 否则红并打印
     「探针过期: 判据体已变, 未重验」—— 与 T226 覆盖见证的过期判据**同形**(那条今天真的红了并起作用);
  ④ 断言 (c) 只有 `verdict == two-arm` 才算已覆盖; 干净臂红一律记「探针无效」, **不得计入已覆盖**。

未绑定的探针(解析不出目标/锚点)**不当通过也不当失败**, 而是像"单臂债"一样**冻结为债**, 只减不增。

用法:
  dsh-probe-binding.py --record      # 解析 guard-fire 里每条带命令的 mustFire, 写 probe-bindings.json(last-wins)
  dsh-probe-binding.py --check       # 逐条断言 (a)(b)(c); exit 0 全绿 / 1 有红 / 3 前提不成立
  dsh-probe-binding.py --check --json
注入(供合成世界判据使用):
  --guard-fire P / --bindings P / --suite P / --repo P
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import re
import sys

TZ = datetime.timezone(datetime.timedelta(hours=8))
REPO_DEFAULT = os.path.expanduser('~/dsh-fork')
TAG = '[probe-binding]'


def cog_dir() -> str:
    return os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')


def load(path: str):
    try:
        with open(path, encoding='utf8') as fh:
            return json.load(fh)
    except Exception:
        return None


def sha(text: str) -> str:
    return hashlib.sha256(text.encode('utf8')).hexdigest()


TRIPLE = re.compile(r'"""(.*?)"""', re.S)
PATHISH = re.compile(r'["\']((?:/|\$HOME/)[^"\'`\n]*?)["\']')


def probe_paths(text: str, repo: str) -> list[str]:
    """探针文本里**真实存在**的仓库内文件路径(候选目标)。"""
    out = []
    for raw in PATHISH.findall(text):
        p = raw.replace('$HOME', os.path.expanduser('~'))
        if not p.startswith('/'):
            continue
        if not os.path.exists(p):
            continue
        if p.endswith('.py') and 'assert-runner' in p:
            continue
        if p not in out:
            out.append(p)
    return out


def f(text: str, needle: str) -> int:
    return text.count(needle)


def extract_anchors(probe_text: str, targets: list[str]) -> tuple[list[dict], str]:
    """锚点 = 探针里长度 >= 20 的三引号字面量, 且在某目标文件里**恰好出现一次**。
    返回 (anchors, 说明)。"""
    hits = []
    for lit in TRIPLE.findall(probe_text):
        if len(lit.strip()) < 20:
            continue
        for t in targets:
            try:
                body = open(t, encoding='utf8').read()
            except Exception:
                continue
            if f(body, lit) == 1:
                hits.append({'file': t, 'fragment': lit, 'sha256': sha(lit)})
                break
    return hits, ('' if hits else '解析不出锚点(探针的变异落点不是三引号字面量, 或目标文件不含它)')


ENVKEY = re.compile(r'DSH_[A-Z0-9_]+')


# 双臂协议自身的旋钮: 由探针**自己**读来决定跑哪一支, 不是判据要消费的注入点 ⇒ 不算耦合键。
# (第一版没排除它 ⇒ 12 条双臂探针全部假红 —— 判据自己当场把教训教了一遍。)
ARM_PROTOCOL_KEYS = {'DSH_PROBE_CLEAN'}


def coupling_keys(probe_text: str) -> list[str]:
    """探针的**注入点**: 它靠这些 DSH_* 旋钮把世界掰弯。B 族探针(注入临时世界)没有可锚定的源码片段,
    但它同样会失效 —— 判据体一旦不再消费这个旋钮, 探针就变成**空壳**(改了世界却没人读)。
    这正是"声明必须被行为消费"那条纪律在探针侧的样子。"""
    return sorted(set(ENVKEY.findall(probe_text)) - ARM_PROTOCOL_KEYS)


def suite_body_text(suite_path: str, name: str) -> tuple[str | None, str]:
    try:
        text = open(suite_path, encoding='utf8').read()
    except Exception as exc:
        return None, '读不到套件: %s' % exc
    m = re.search(r't\s+"' + re.escape(name) + r'"\s+python3 -c \'\n(.*?)\n\'\n', text, re.S)
    if not m:
        return None, '套件里找不到该断言体(名字对不上, 或它不是 python3 -c 型)'
    return m.group(1), ''


def suite_body_sha(suite_path: str, name: str) -> tuple[str | None, str]:
    """判据体 = 套件里 `t "<name>" python3 -c '` 到行首 `'` 之间的那段(**判据真正执行的东西**)。"""
    body, err = suite_body_text(suite_path, name)
    return (None, err) if body is None else (sha(body), '')


FILELIKE = re.compile(r'[~\w./-]*?[\w-]+\.(?:py|sh|mts|ts)')


def consumption_depth(key: str, body_txt: str, suite: str, max_depth: int = 2, budget: int = 40) -> int:
    """旋钮 `key` 在判据体里被消费了吗? 返回**发现深度**(0 = 体里直接出现), -1 = 深度<=2 内都找不到。
    为什么要传递: 判据体常常只 `bash ~/dsh-fork/xxx.sh`, 旋钮由那层脚本再转给工具 —— 只看一层会把
    **真消费**误判成空壳(第一版就是这样, 12 条双臂探针全假红)。扫描有界(深度 2 / 最多 40 个文件), 免得跑飞。"""
    if key in body_txt:
        return 0
    seen, frontier, depth = set(), [], 0
    for raw in FILELIKE.findall(body_txt):
        path = os.path.expanduser(raw)
        if not os.path.isabs(path):
            path = os.path.join(os.path.expanduser('~/dsh-fork'), path)
        if os.path.isfile(path) and path != suite:
            frontier.append(path)
    while frontier and depth < max_depth:
        depth += 1
        nxt = []
        for path in frontier:
            if path in seen or len(seen) >= budget:
                continue
            seen.add(path)
            try:
                text = open(path, encoding='utf8').read()
            except Exception:
                continue
            if key in text:
                return depth
            for raw in FILELIKE.findall(text):
                q = os.path.expanduser(raw)
                if not os.path.isabs(q):
                    q = os.path.join(os.path.expanduser('~/dsh-fork'), q)
                if os.path.isfile(q) and q not in seen and q != suite:
                    nxt.append(q)
        frontier = nxt
    return -1


def file_sha(path: str) -> str:
    try:
        return hashlib.sha256(open(path, 'rb').read()).hexdigest()
    except Exception:
        return ''


def probe_name(probe_text: str) -> str:
    m = re.search(r'^NAME="([^"]+)"', probe_text, re.M)
    return m.group(1) if m else ''


def bindings_path(args) -> str:
    return args.bindings or os.path.join(cog_dir(), 'probe-bindings.json')


def guard_path(args) -> str:
    return args.guard_fire or os.path.join(cog_dir(), 'guard-fire.json')


def suite_path(args) -> str:
    return args.suite or os.path.join(args.repo, 'dsh-cog-tests.sh')


def entries(reg: dict) -> list[tuple[str, str, dict]]:
    out = []
    for g in (reg.get('guards') or []):
        gid = str(g.get('guard') or '')
        for mf in (g.get('mustFire') or []):
            if mf.get('command'):
                out.append(('%s|%s' % (gid, str(mf.get('assertion') or '')[:40]), gid, mf))
    return out


def record(args) -> int:
    reg = load(guard_path(args))
    if not reg:
        print('%s 读不到开火登记簿: %s' % (TAG, guard_path(args)), file=sys.stderr)
        return 3
    suite = suite_path(args)
    at = reg.get('armsMeasuredAt') or datetime.datetime.now(TZ).isoformat()
    base = load(os.path.join(cog_dir(), 'probe-arms-baseline.json')) or {}
    frozen = set(base.get('frozenSingleArm') or [])
    rows, unbound = [], []
    for key, gid, mf in entries(reg):
        cmd = str(mf['command'])
        m = re.search(r'(/\S+?\.sh)', cmd)
        probe = m.group(1) if m and os.path.exists(m.group(1)) else ''
        if not probe:
            unbound.append({'key': key, 'guard': gid, 'why': '命令里解析不出探针脚本'})
            continue
        ptext = open(probe, encoding='utf8').read()
        anchors, why = extract_anchors(ptext, probe_paths(ptext, args.repo))
        name = probe_name(ptext)
        bsha, bwhy = (suite_body_sha(suite, name) if name else (None, '探针未声明 NAME'))
        ckeys = coupling_keys(ptext)
        rec = {'guard': gid, 'key': key, 'assertion': mf.get('assertion') or '', 'command': cmd, 'probe': probe,
               'name': name, 'anchors': anchors, 'couplingKeys': ckeys, 'bodySha256': bsha, 'verifiedAt': at,
               'arms': mf.get('arms') or None, 'verdict': mf.get('verdict') or None,
               'inDebt': key in frozen,
               # "未绑定" = 既锚不到片段(A 族)也没有注入点(B 族) ⇒ 探针的有效性无从复核
               'unbound': (not anchors) and (not ckeys)}
        rows.append(rec)
        if rec['unbound']:
            unbound.append({'key': key, 'guard': gid, 'why': '；'.join(x for x in (why, bwhy) if x)
                            + '；也没有 DSH_* 注入点'})
    prev = load(bindings_path(args)) or {}
    # 注入点未被判据路径消费的条数(只报告, 不当硬红) —— 与未绑定数一样**只减不增**:
    # 重录时取"历史最小", 否则修好一批又坏一批会被"重录"洗掉。
    _inc = sum(1 for r in rows for k in (r.get('couplingKeys') or [])
               if consumption_depth(k, (suite_body_text(suite, r.get('name') or '')[0] or ''), suite) < 0)
    payload = {'recordedAt': datetime.datetime.now(TZ).isoformat(), 'suite': suite,
               'probes': rows, 'unbound': unbound, 'unboundCount': len(unbound),
               'inconsumedCount': min(int(prev.get('inconsumedCount', _inc)), _inc),
               'note': ('锚点/判据体哈希绑定的登记簿, 由 dsh-probe-binding.py --record 生成。'
                        '未绑定探针像"单臂债"一样冻结: 只减不增。')}
    p = bindings_path(args)
    tmp = p + '.tmp'
    with open(tmp, 'w', encoding='utf8') as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)
        fh.flush()
        os.fsync(fh.fileno())
    try:  # cl-332: 覆写必须保留权限位(临时文件+replace 会带 umask 默认权限)
        os.chmod(tmp, os.stat(p).st_mode & 0o7777)
    except Exception:
        pass
    os.replace(tmp, p)
    print('%s 已登记 %d 条(其中未绑定 %d 条: 锚点或判据体解析不出) → %s'
          % (TAG, len(rows), len(unbound), p), file=sys.stderr)
    for u in unbound[:8]:
        print('%s   · 未绑定 %s: %s' % (TAG, u['guard'], u['why']), file=sys.stderr)
    return 0


def check(args) -> int:
    bn = load(bindings_path(args))
    if not bn or not bn.get('probes'):
        print('%s 读不到绑定登记簿(或为空): %s ⇒ 前提不成立' % (TAG, bindings_path(args)), file=sys.stderr)
        return 3
    suite = bn.get('suite') or suite_path(args)
    # 快照自检(2026-09-13 实测的必要性): 本工具读的套件/登记簿都是**别的会话也在写**的共享文件 ——
    # 实测同一个 T223 在相隔数秒的两次运行里一次红一次绿(读到了半写状态的套件) ⇒ 结论不可用。
    snap = file_sha(suite)
    reds, greens, inconsumed, half_bound = [], [], [], []
    unbound_now = 0
    for rec in bn['probes']:
        gid, why = rec.get('guard'), []
        if rec.get('unbound'):
            # 未绑定 = 债(与"单臂债"同待遇): 逐条硬红会有 14 条假红, 且**修不动**(很多探针按设计就没有源码锚点)。
            # 判红只在**债变多**时发生(见下面的 frozen_unbound 比较)。
            unbound_now += 1
        # (a) 锚点仍在且唯一
        for a in (rec.get('anchors') or []):
            path, frag = a['file'], a['fragment']
            try:
                body = open(path, encoding='utf8').read()
            except Exception as exc:
                why.append('锚点漂移: 目标文件读不到(%s)' % exc)
                continue
            n = f(body, frag)
            if n != 1:
                why.append('锚点漂移: 探针已失效(片段在 %s 里出现 %d 次, 期望 1)' % (os.path.basename(path), n))
        # (b0) **半绑定必须判红**(tp-201 的前置修法, 2026-09-13 22:3x):
        # 锚点绑上了、但判据体取不到(NAME 解析不出 / 断言名对不上) ⇒ 以前会**静默跳过整段过期检查** ⇒
        # 判据在「测了个空」时报绿。这正是 T230 第一版合成世界踩到的那条**假绿**路径(探针 NAME 用单引号 ⇒ name='')。
        if rec.get('anchors') and not rec.get('bodySha256'):
            # 债条(冻结的单臂探针)**只报告**: 对一条已知未验证的探针再判"过期检查无从进行"是误伤(实测 T118),
            # 债的收口方式是把它变成双臂, 不是多一条红。
            (half_bound if rec.get('inDebt') else why).append(
                '半绑定: 锚点绑上了但判据体取不到(NAME 解析不出或断言名不匹配) ⇒ 过期检查无从进行')
        # (b) 判据体哈希: 一致, 或体改了但已重验
        if rec.get('bodySha256'):
            cur, err = suite_body_sha(suite, rec.get('name') or '')
            if cur is None:
                why.append('判据体取不到: %s' % err)
            elif cur != rec['bodySha256']:
                try:
                    body_mtime = os.path.getmtime(suite)
                    verified = datetime.datetime.fromisoformat(str(rec.get('verifiedAt'))).timestamp()
                except Exception:
                    verified, body_mtime = 0.0, 1.0
                if verified <= body_mtime:
                    why.append('探针过期: 判据体已变, 未重验(登记于 %s, 体改动于 %s)'
                               % (rec.get('verifiedAt'), datetime.datetime.fromtimestamp(
                                   body_mtime, TZ).isoformat()))
        # (c'') 注入点是否被判据路径消费 —— **只报告, 不当硬红**(tp-200 执行中实测修正):
        # 自动判定分不清「判据必须消费的旋钮」与「探针自己用的旋钮」(如 T196 的 DSH_COG_POOL:
        # 判据体用绝对路径调工具, 该旋钮在体与工具里都不出现 ⇒ 探针拿它做自己的临时世界)。
        # 硬红会得到 ~29 条假红(实测), 于是降级为**只报告 + 冻结为债(只减不增)**, 由人逐条裁决语义。
        body_txt, _ = suite_body_text(suite, rec.get('name') or '')
        for k in (rec.get('couplingKeys') or []):
            # 注意: consumption_depth 用 **0 表示"体里直接找到"**, -1 才是没找到。
            # 第一版写成 `if not consumption_depth(...)` ⇒ 0 为假 ⇒ **找到也被判成没消费**(整批假红)。
            if consumption_depth(k, body_txt or '', suite) < 0:
                inconsumed.append('%s 转 `%s`' % (gid, k))
        # (c) 只有 two-arm 才算已覆盖
        arms = rec.get('arms') or {}
        v = rec.get('verdict')
        if v is None:
            exp = 1
            m, c = arms.get('mutant'), arms.get('clean')
            v = 'two-arm' if (m == exp and c == 0) else ('unknown' if m is None else
                                                         'single-arm' if c == exp else 'other')
        if v != 'two-arm' and not rec.get('inDebt'):
            why.append('探针无效: 变异臂/干净臂不构成可区分(裁决 %s, arms=%s)' % (v, arms))
        (reds if why else greens).append({'guard': gid, 'why': why})
    for r in reds:
        print('%s **判红** %s: %s' % (TAG, r['guard'], ' ｜ '.join(r['why'])), file=sys.stderr)
    if snap and file_sha(suite) != snap:
        print('%s 判据体在测量期间被改写(%s) ⇒ 本次结论不可用(并发写入)' % (TAG, os.path.basename(suite)),
              file=sys.stderr)
        return 3
    if half_bound:
        print('%s 半绑定(债条, 只报告): %s' % (TAG, '; '.join(half_bound[:6])))
    frozen_inc = int(bn.get('inconsumedCount') or 0)
    print('%s 注入点未被判据路径消费(只报告, 非硬红): %d 条 / 冻结基线 %d 条%s'
          % (TAG, len(inconsumed), frozen_inc, (': ' + '; '.join(inconsumed[:6])) if inconsumed else ''))
    frozen_unbound = int(bn.get('unboundCount') or 0)
    if unbound_now > frozen_unbound:
        reds.append({'guard': '(债)未绑定探针数', 'why': ['未绑定探针 %d 条 > 冻结基线 %d 条 ⇒ 债只减不增'
                                                          % (unbound_now, frozen_unbound)]})
    print('%s %d 条探针: 有效 %d / 判红 %d / 未绑定 %d(冻结基线 %d)'
          % (TAG, len(bn['probes']), len(greens), len(reds), unbound_now, frozen_unbound))
    if args.json:
        print(json.dumps({'probes': len(bn['probes']), 'green': len(greens), 'red': reds,
                          'unbound': unbound_now,
                          'unboundCount': bn.get('unboundCount')}, ensure_ascii=False))
    return 1 if reds else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--record', action='store_true')
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--guard-fire', dest='guard_fire', default=None)
    ap.add_argument('--bindings', default=None)
    ap.add_argument('--suite', default=None)
    ap.add_argument('--repo', default=REPO_DEFAULT)
    args = ap.parse_args()
    if args.record == args.check:
        ap.error('--record 与 --check 必须二选一')
    return record(args) if args.record else check(args)


if __name__ == '__main__':
    sys.exit(main())
