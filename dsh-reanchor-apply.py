#!/usr/bin/env python3
"""dsh-reanchor-apply.py — 停机窗口内的链锚数据修复（cl-075 / cl-076 的离线对应动作）。

为什么必须停机做（cl-030 教训）：认知管线的 experiences.jsonl / chain_anchors.json 在运行时
是"内存全量回写"——进程还持有旧值，离线改文件会被下一次 flush 覆盖。只有在服务停、进程无
内存副本的窗口里改，才真正落盘。

做两件事：
  1. 应用 reanchor-pending.jsonl 里的待修链锚（无锚/错锚经验 → 指定目标链），应用后归档该文件；
  2. 清除指向"非 active 目标"的过期粘性锚（与 resolveChainAnchor 的运行期守卫同规则）。

用法: python3 dsh-reanchor-apply.py [--base ~/.dsh/cognitive-pipeline]
退出码: 0 = 正常（含无事可做）；非 0 = 出错。
"""
import json, os, sys, datetime, shutil


def main() -> int:
    base = os.path.expanduser('~/.dsh/cognitive-pipeline')
    args = sys.argv[1:]
    if '--base' in args:
        base = os.path.expanduser(args[args.index('--base') + 1])

    exp_path = os.path.join(base, 'experiences.jsonl')
    pool_path = os.path.join(base, 'dormant-goals.jsonl')
    anchor_path = os.path.join(base, 'chain_anchors.json')
    pending_path = os.path.join(base, 'reanchor-pending.jsonl')

    rows = []
    if os.path.exists(exp_path):
        with open(exp_path, encoding='utf8') as f:
            for line in f:
                line = line.strip()
                if line:
                    rows.append(json.loads(line))

    # 1) 应用待修链锚
    applied = 0
    remaining = 0
    if os.path.exists(pending_path):
        pend = [json.loads(l) for l in open(pending_path, encoding='utf8') if l.strip()]
        want = {r['expId']: r['chainId'] for r in pend if r.get('expId') and r.get('chainId')}
        done = set()
        for r in rows:
            target = want.get(r.get('expId'))
            if target and r.get('chainId') != target:
                r['chainId'] = target
                applied += 1
            if target:
                done.add(r.get('expId'))
        remaining = len([k for k in want if k not in done])
        if applied:
            with open(exp_path, 'w', encoding='utf8') as f:
                f.write('\n'.join(json.dumps(x, ensure_ascii=False) for x in rows) + '\n')
        stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
        shutil.move(pending_path, pending_path + '.applied-' + stamp)
    print('[reanchor] 待修链锚应用 %d 条 (未找到 %d 条)' % (applied, remaining))

    # 2) 清除指向非 active 目标的粘性锚
    pool = {}
    if os.path.exists(pool_path):
        with open(pool_path, encoding='utf8') as f:
            for line in f:
                line = line.strip()
                if line:
                    g = json.loads(line)
                    if g.get('id'):
                        pool[g['id']] = g.get('status')
    try:
        anchors = json.load(open(anchor_path, encoding='utf8'))
        if not isinstance(anchors, dict):
            anchors = {}
    except Exception:
        anchors = {}
    cleared = [s for s, g in anchors.items() if g in pool and pool[g] != 'active']
    for s in cleared:
        anchors.pop(s, None)
    with open(anchor_path, 'w', encoding='utf8') as f:
        json.dump(anchors, f, ensure_ascii=False)
    print('[reanchor] 过期粘性锚清除 %d 个 %s' % (len(cleared), cleared))
    return 0


if __name__ == '__main__':
    sys.exit(main())
